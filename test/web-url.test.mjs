/**
 * dsh_web_url 的 includeToken 权限门槛测试。
 *
 * 不 mock 模块：直接 apply() 一个假 ctx，从注册表里捞出工具，再按
 * execute(input, execution) 的真实签名调用。这样测的是线上那条路径。
 *
 * 门槛必须是 fail closed：下面一半的用例都在证明「读不到权限 → 不发 token」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, inject, name } from "../index.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz";
const ORIGIN = "http://127.0.0.1:64762";
const FULL_URL = `${ORIGIN}/?token=${TOKEN}`;

/**
 * 建一个假宿主：注册表 + 可配置的宿主服务。
 *
 * @param {{ services?: Record<string, any> }} [options]
 */
function fakeHost({ services = {} } = {}) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(key) {
      if (key in services) {
        const value = services[key];
        if (value instanceof Error) throw value;
        return value;
      }
      return undefined;
    },
    logger: { warn() {} },
  };
  apply(ctx);
  return {
    ctx,
    tools,
    /** 调一个已注册工具。 */
    async run(toolName, input, execution) {
      const definition = tools.get(toolName);
      assert.ok(definition, `工具 ${toolName} 未注册`);
      return definition.execute(input, execution);
    },
    /** 调一个工具并走 output.render，得到给模型看的文本。 */
    async render(toolName, input, execution) {
      const definition = tools.get(toolName);
      const value = await definition.execute(input, execution);
      const blocks = definition.output.render(input, value);
      return { value, text: blocks.map((block) => block.text).join("\n") };
    },
    /** 走了卸载路径后工具应被清空。 */
    dispose() {
      return ctx;
    },
  };
}

/** 标准可用的 webApp / connection。 */
const baseServices = () => ({
  webApp: { getAdvertisedUrl: () => ORIGIN },
  connection: { authenticatedUrl: (origin) => `${origin}/?token=${TOKEN}` },
});

/** 一个假 session；permissionPresets 只看它是不是真值。 */
const SESSION = { id: "session-1" };
/** 一次真实形态的 execution。 */
const EXECUTION = { agent: { session: SESSION }, signal: new AbortController().signal };

// ── 基本形态 ───────────────────────────────────────────────────────────────

test("插件仍然导出 apply / inject / name", () => {
  assert.equal(typeof apply, "function");
  assert.equal(name, "dsh-session-bridge");
  assert.deepEqual(inject, ["tools"]);
});

test("五个工具都注册了", () => {
  const host = fakeHost({ services: baseServices() });
  assert.deepEqual([...host.tools.keys()].sort(), [
    "dsh_session_cancel",
    "dsh_session_create",
    "dsh_session_prompt",
    "dsh_session_read",
    "dsh_web_url",
  ]);
});

// ── 默认（不打 token）──────────────────────────────────────────────────────

test("不带 includeToken：返回打码 URL，不需要任何权限服务", async () => {
  const host = fakeHost({ services: baseServices() });
  const value = await host.run("dsh_web_url", {}, EXECUTION);
  assert.equal(value.ok, true);
  assert.equal(value.tokenIncluded, false);
  assert.equal(value.url, `${ORIGIN}/?token=abcd...wxyz`);
  assert.equal(value.origin, ORIGIN);
  assert.ok(!value.url.includes(TOKEN), "打码 URL 里不能出现完整 token");
});

test("includeToken:false 显式传：同样打码", async () => {
  const host = fakeHost({ services: baseServices() });
  const value = await host.run("dsh_web_url", { includeToken: false }, EXECUTION);
  assert.equal(value.ok, true);
  assert.equal(value.tokenIncluded, false);
  assert.ok(!value.url.includes(TOKEN));
});

test("没有 permissionPresets 服务时默认路径照旧可用", async () => {
  const host = fakeHost({ services: baseServices() });
  const value = await host.run("dsh_web_url", {}, undefined);
  assert.equal(value.ok, true);
  assert.equal(value.tokenIncluded, false);
});

// ── danger-full-access：放行 ───────────────────────────────────────────────

test("danger-full-access 档位 → 发放明文 token", async () => {
  const host = fakeHost({
    services: {
      ...baseServices(),
      permissionPresets: {
        current: (session) => {
          assert.equal(session, SESSION);
          return "unrestricted";
        },
        resolve: (preset) => {
          assert.equal(preset, "unrestricted");
          return { sandbox: "danger-full-access", approval: "never", name: "Unrestricted" };
        },
      },
    },
  });
  const value = await host.run("dsh_web_url", { includeToken: true }, EXECUTION);
  assert.equal(value.ok, true);
  assert.equal(value.tokenIncluded, true);
  assert.equal(value.url, FULL_URL);
  assert.deepEqual(value.permission, { preset: "unrestricted", sandbox: "danger-full-access" });
});

// ── 其它档位：拒绝 ─────────────────────────────────────────────────────────

for (const sandbox of ["read-only", "workspace-write"]) {
  test(`${sandbox} 档位 → insufficient-permission，退回打码 URL`, async () => {
    const host = fakeHost({
      services: {
        ...baseServices(),
        permissionPresets: {
          current: () => "safe",
          resolve: () => ({ sandbox, approval: "ask" }),
        },
      },
    });
    const { value, text } = await host.render(
      "dsh_web_url",
      { includeToken: true },
      EXECUTION,
    );
    assert.equal(value.ok, false);
    assert.equal(value.error.code, "insufficient-permission");
    assert.ok(value.error.message.includes(sandbox), `原因里应点名档位：${value.error.message}`);
    assert.equal(value.tokenIncluded, false);
    assert.equal(value.url, `${ORIGIN}/?token=abcd...wxyz`, "拒绝时也要给打码 URL");
    assert.equal(value.origin, ORIGIN);
    assert.ok(!JSON.stringify(value).includes(TOKEN), "整个结果都不能出现明文 token");
    assert.match(text, /insufficient-permission/);
  });
}

// ── fail closed：任何一环读不到都拒绝 ─────────────────────────────────────

const failClosedCases = [
  {
    label: "permissionPresets 服务缺席",
    services: () => ({}),
  },
  {
    label: "permissionPresets 缺 current 方法",
    services: () => ({ permissionPresets: { resolve: () => ({ sandbox: "danger-full-access" }) } }),
  },
  {
    label: "permissionPresets 缺 resolve 方法",
    services: () => ({ permissionPresets: { current: () => "unrestricted" } }),
  },
  {
    label: "ctx.get 抛异常",
    services: () => ({ permissionPresets: new Error("service unavailable") }),
  },
  {
    label: "current() 抛异常",
    services: () => ({
      permissionPresets: {
        current: () => {
          throw new Error("no current preset");
        },
        resolve: () => ({ sandbox: "danger-full-access" }),
      },
    }),
  },
  {
    label: "current() 返回 'custom' 且 resolve 抛错",
    services: () => ({
      permissionPresets: {
        current: () => "custom",
        resolve: () => {
          throw new Error("unknown preset: custom");
        },
      },
    }),
  },
  {
    label: "current() 返回空串",
    services: () => ({ permissionPresets: { current: () => "", resolve: () => ({}) } }),
  },
  {
    label: "current() 返回非字符串",
    services: () => ({ permissionPresets: { current: () => null, resolve: () => ({}) } }),
  },
  {
    label: "resolve() 返回 undefined",
    services: () => ({ permissionPresets: { current: () => "x", resolve: () => undefined } }),
  },
  {
    label: "resolve() 缺 sandbox",
    services: () => ({
      permissionPresets: { current: () => "x", resolve: () => ({ approval: "never" }) },
    }),
  },
  {
    label: "sandbox 是未知字符串",
    services: () => ({
      permissionPresets: { current: () => "x", resolve: () => ({ sandbox: "root" }) },
    }),
  },
];

for (const item of failClosedCases) {
  test(`fail closed: ${item.label}`, async () => {
    const host = fakeHost({ services: { ...baseServices(), ...item.services() } });
    const value = await host.run("dsh_web_url", { includeToken: true }, EXECUTION);
    assert.equal(value.ok, false, `${item.label} 应被拒绝`);
    assert.equal(value.error.code, "insufficient-permission");
    assert.equal(value.tokenIncluded, false);
    assert.ok(!JSON.stringify(value).includes(TOKEN), "拒绝路径不能漏出明文 token");
  });
}

test("fail closed: execution 缺席（拿不到 session）", async () => {
  const host = fakeHost({
    services: {
      ...baseServices(),
      permissionPresets: {
        current: () => "unrestricted",
        resolve: () => ({ sandbox: "danger-full-access" }),
      },
    },
  });
  const value = await host.run("dsh_web_url", { includeToken: true }, undefined);
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "insufficient-permission");
  assert.equal(value.tokenIncluded, false);
});

test("fail closed: execution.agent 缺席", async () => {
  const host = fakeHost({
    services: {
      ...baseServices(),
      permissionPresets: {
        current: () => "unrestricted",
        resolve: () => ({ sandbox: "danger-full-access" }),
      },
    },
  });
  const value = await host.run("dsh_web_url", { includeToken: true }, { signal: null });
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "insufficient-permission");
});

test("fail closed: session 缺席（permissionPresets 在场）", async () => {
  let currentCalls = 0;
  const host = fakeHost({
    services: {
      ...baseServices(),
      permissionPresets: {
        current: () => {
          currentCalls += 1;
          return "unrestricted";
        },
        resolve: () => ({ sandbox: "danger-full-access" }),
      },
    },
  });
  const value = await host.run("dsh_web_url", { includeToken: true }, { agent: {} });
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "insufficient-permission");
  assert.equal(currentCalls, 0, "拿不到 session 就不该去问权限服务");
});

test("门槛不误伤其它工具：没有 permissionPresets 也能建会话", async () => {
  const host = fakeHost({
    services: {
      ...baseServices(),
      sessionController: {
        async create(request) {
          assert.deepEqual(request, { cwd: "/tmp" });
          return { sessionId: "new-1", agentPreset: "default" };
        },
      },
    },
  });
  const value = await host.run("dsh_session_create", { cwd: "/tmp" }, EXECUTION);
  assert.equal(value.ok, true);
  assert.equal(value.sessionId, "new-1");
});

test("没有 webApp 时 includeToken 直接报 no-web-app（不走进权限判定）", async () => {
  const host = fakeHost({ services: {} });
  const value = await host.run("dsh_web_url", { includeToken: true }, EXECUTION);
  assert.equal(value.ok, false);
  assert.equal(value.error.code, "no-web-app");
});
