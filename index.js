/**
 * dsh-session-bridge —— 让 Agent 自己开前台会话、驱动它、并把结果读回来。
 *
 * 为什么需要它
 * ─────────────
 * Host 里其实已经有全套能力，只是没有暴露给 Agent：
 *
 *   ctx.sessionController  create / prompt / inspect / list / cancel
 *                          —— 跟 GUI 点「新建会话」走的是同一条路
 *   ctx.connection         authenticatedUrl(baseUrl)
 *                          —— 返回带启动 token 的 URL，浏览器访问它就会
 *                             自动换成签名 cookie
 *
 * 没有这个插件时，Agent 想在前台会话里做一次真实验证，只能：
 *   1. 去翻 Chromium 的 cookie 存储捞 dsh-auth-*（还要猜端口是否匹配）
 *   2. 手工逆向 /api/* 的 RPC 报文形状
 *   3. 用 DOM 事件往输入框里塞文本
 * 有了这个插件，这三步各自变成一个工具调用。
 *
 * 关键点：这里创建的是**前台会话**（root agent），不是委派子任务。
 * 委派任务没有 userQuestions 服务，像 Computer Use 的按应用授权会直接
 * 报 APP_APPROVAL_UNAVAILABLE；前台会话可以正常弹窗让人回答。
 */

import { randomUUID } from "node:crypto";

import { maskToken, transcribe, waitForTurn } from "./lib/format.js";

/** 插件名（与 cordis.patch.yml 的行 id 一致）。 */
export const name = "dsh-session-bridge";

/**
 * 只硬依赖 tools。sessionController / connection / webApp 都可能缺席
 * （headless 就没有 webApp），缺席时工具给出可读的错误而不是挂载失败。
 */
export const inject = ["tools"];

/** 统一的结果形状：ok=false 时带 error，模型能直接读懂。 */
function fail(code, message, hint) {
  return { ok: false, error: { code, message, hint: hint ?? null } };
}

/** 取宿主服务；缺席时返回 null，由调用方决定怎么报错。 */
function service(ctx, key) {
  try {
    return ctx.get(key) ?? null;
  } catch {
    return null;
  }
}

/** 允许拿到明文启动 token 的 sandbox 档位。 */
const TOKEN_SANDBOX = "danger-full-access";

/**
 * 判断这次调用是否有资格拿明文启动 token。
 *
 * token 能让人拿到浏览器里的全权控制，所以门槛要 fail closed：
 * 只要有任何一环拿不到确定答案（服务缺席、方法缺失、抛错、返回形状不对），
 * 都算「没权限」，绝不因为读不到信息而放行。
 *
 * @param {any} ctx 宿主上下文
 * @param {any} session 调用方会话（execution.agent.session）
 * @returns {{ allowed: boolean, preset: string|null, sandbox: string|null, reason: string }}
 *   allowed=false 时 reason 说明具体卡在哪一步，便于模型自查。
 */
function checkTokenPermission(ctx, session) {
  if (!session) {
    return {
      allowed: false,
      preset: null,
      sandbox: null,
      reason: "拿不到当前会话（execution.agent.session 为空），无法确认权限档位",
    };
  }
  // permissionPresets 是可选的宿主服务：老版本 / 精简部署可能没有。
  const presets = service(ctx, "permissionPresets");
  if (!presets || typeof presets.current !== "function" || typeof presets.resolve !== "function") {
    return {
      allowed: false,
      preset: null,
      sandbox: null,
      reason: "宿主没有可用的 permissionPresets 服务，无法确认权限档位",
    };
  }
  let preset;
  try {
    preset = presets.current(session);
  } catch (error) {
    return {
      allowed: false,
      preset: null,
      sandbox: null,
      reason: `读取当前权限档位失败：${String(error?.message ?? error)}`,
    };
  }
  if (typeof preset !== "string" || preset === "") {
    return {
      allowed: false,
      preset: null,
      sandbox: null,
      reason: "宿主未能给出当前权限档位名",
    };
  }
  let spec;
  try {
    spec = presets.resolve(preset);
  } catch (error) {
    // current() 返回 'custom' 时 resolve() 可能抛错——按无权限处理。
    return {
      allowed: false,
      preset,
      sandbox: null,
      reason: `权限档位 ${preset} 无法解析：${String(error?.message ?? error)}`,
    };
  }
  const sandbox = typeof spec?.sandbox === "string" ? spec.sandbox : null;
  if (!sandbox) {
    return { allowed: false, preset, sandbox: null, reason: `权限档位 ${preset} 没有 sandbox 信息` };
  }
  if (sandbox !== TOKEN_SANDBOX) {
    return {
      allowed: false,
      preset,
      sandbox,
      reason: `当前权限档位 ${preset} 的 sandbox=${sandbox}，需要 ${TOKEN_SANDBOX}`,
    };
  }
  return { allowed: true, preset, sandbox, reason: "ok" };
}

/** 一个工具的 output.render：把结果对象变成给模型看的文本块。 */
function renderResult(value) {
  if (value && value.ok === false) {
    const error = value.error ?? {};
    const hint = error.hint ? `\n提示：${error.hint}` : "";
    return [
      {
        type: "text",
        text: `失败（${error.code ?? "error"}）：${error.message ?? "未知错误"}${hint}`,
      },
    ];
  }
  if (value && value.transcript) {
    const { messages, toolCalls, turns, lastTurnReason } = value.transcript;
    const lines = [];
    if (value.meta) {
      lines.push(
        `会话 ${value.meta.id}｜preset=${value.meta.agentPreset ?? "默认"}｜cwd=${value.meta.cwd ?? "—"}`,
      );
    }
    lines.push(`回合数=${turns}｜最后回合=${lastTurnReason ?? "未结束"}｜running=${value.running}`);
    for (const message of messages) {
      lines.push(`\n[${message.role}]\n${message.text}`);
    }
    if (toolCalls.length > 0) {
      lines.push("\n工具调用：");
      for (const call of toolCalls) {
        if (call.name !== undefined && call.arguments !== undefined) {
          lines.push(`- ${call.name}(${call.arguments})${call.isError ? " [错误]" : ""}`);
        } else if (call.result !== undefined) {
          lines.push(`- → ${call.result}${call.isError ? " [错误]" : ""}`);
        }
      }
    }
    if (value.truncated) lines.push("\n（输出已截断，需要完整内容请用更小的 maxMessages 或分段读取）");
    return [{ type: "text", text: lines.join("\n") }];
  }
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/**
 * 挂载本插件。
 *
 * @param {any} ctx 宿主上下文
 * @returns {() => void} 卸载回调
 */
export function apply(ctx) {
  const disposers = [];

  const register = (definition) => {
    try {
      const dispose = ctx.tools.register({
        ...definition,
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => renderResult(value),
        },
      });
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-session-bridge: 工具 ${definition.name} 注册失败`, error?.message ?? error);
    }
  };

  // ── dsh_web_url ──────────────────────────────────────────────────────────
  register({
    name: "dsh_web_url",
    description:
      "返回本机 DeepSeek Harness Web GUI 的访问地址。" +
      "默认（maskToken=true）只返回 origin 和一个打码后的 url，不泄露启动 token。" +
      "需要真正打开浏览器时传 includeToken=true 才返回带 token 的完整地址；" +
      "该 token 是活的凭据，不要把它贴进聊天记录、日志或提交里。" +
      "includeToken=true 要求当前会话的权限档是 danger-full-access，否则返回 " +
      "insufficient-permission 并退回打码 URL。",
    parameters: {
      type: "object",
      properties: {
        includeToken: {
          type: "boolean",
          description:
            "true 时返回带启动 token 的完整地址（可直接给浏览器打开）；" +
            "省略或 false 时 token 被打码。默认 false。" +
            "仅当当前会话权限档为 danger-full-access 时可用。",
        },
      },
      additionalProperties: false,
    },
    async execute(input, execution) {
      const webApp = service(ctx, "webApp");
      const connection = service(ctx, "connection");
      if (!webApp || typeof webApp.getAdvertisedUrl !== "function") {
        return fail(
          "no-web-app",
          "当前宿主没有 Web GUI（webApp 服务不可用）",
          "这个插件只在带 Web GUI 的 Desktop / Web 部署里有用；headless 部署下请忽略",
        );
      }
      const origin = webApp.getAdvertisedUrl();
      const full =
        connection && typeof connection.authenticatedUrl === "function"
          ? connection.authenticatedUrl(origin)
          : origin;
      const includeToken = input?.includeToken === true;
      if (includeToken) {
        // 明文 token = 浏览器全权控制，按调用会话的权限档放行；读不到就拒绝。
        const permission = checkTokenPermission(ctx, execution?.agent?.session);
        if (!permission.allowed) {
          // 拒绝时仍给出打码 URL：调用方拿不到 token，但至少能看到地址。
          return {
            ...fail(
              "insufficient-permission",
              `无权获取明文启动 token：${permission.reason}`,
              "token 等同于浏览器全权控制，只发给 danger-full-access 档位的会话。" +
                "如需打开页面，可以先用默认的打码 URL 确认地址，再由人手工打开；" +
                "或在充分确认风险后把当前会话切到 danger-full-access 档位重试。",
            ),
            url: maskToken(full),
            origin,
            tokenIncluded: false,
          };
        }
        return {
          ok: true,
          url: full,
          origin,
          tokenIncluded: true,
          permission: { preset: permission.preset, sandbox: permission.sandbox },
          warning: "该 URL 含活的启动 token，用完不要留存、不要贴进聊天或提交。",
        };
      }
      return {
        ok: true,
        url: maskToken(full),
        origin,
        tokenIncluded: false,
        hint: "需要浏览器直接可用请传 includeToken=true（需 danger-full-access 权限档）；默认不返回明文 token。",
      };
    },
  });

  // ── dsh_session_create ───────────────────────────────────────────────────
  register({
    name: "dsh_session_create",
    description:
      "新建一个前台会话（跟 GUI 点「新建会话」等价），返回会话 id。" +
      "前台会话与委派子任务不同：它带 userQuestions 服务，能向人弹窗征求授权，" +
      "因此 Computer Use 这类需要人工批准的插件只能在这种会话里跑通。",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", minLength: 1, description: "会话的工作目录" },
        agentPreset: {
          type: "string",
          minLength: 1,
          description: "Agent 预设 id；省略则用配置里的默认预设",
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const sessionController = service(ctx, "sessionController");
      if (!sessionController) {
        return fail("no-session-controller", "宿主服务 sessionController 不可用");
      }
      try {
        const request = {};
        if (input?.cwd) request.cwd = input.cwd;
        if (input?.agentPreset) request.agentPreset = input.agentPreset;
        const created = await sessionController.create(request);
        return {
          ok: true,
          sessionId: created?.sessionId,
          agentPreset: created?.agentPreset ?? null,
        };
      } catch (error) {
        return fail("create-failed", String(error?.message ?? error));
      }
    },
  });

  // ── dsh_session_prompt ───────────────────────────────────────────────────
  register({
    name: "dsh_session_prompt",
    description:
      "往一个已存在的会话发送一条提示词并返回是否被接收。" +
      "mode=queue 排队，mode=steer 插队打断当前回合。" +
      "发完用 dsh_session_read 读回结果。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, description: "目标会话 id" },
        text: { type: "string", minLength: 1, description: "提示词正文" },
        mode: {
          type: "string",
          enum: ["queue", "steer"],
          description: "queue 排队等当前回合结束；steer 立刻插队（默认 queue）",
        },
      },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
    async execute(input, execution) {
      const sessionController = service(ctx, "sessionController");
      if (!sessionController) {
        return fail("no-session-controller", "宿主服务 sessionController 不可用");
      }
      try {
        const value = await sessionController.prompt(
          {
            requestId: randomUUID(),
            sessionId: input.sessionId,
            mode: input.mode === "steer" ? "steer" : "queue",
            content: [{ type: "text", text: input.text }],
          },
          execution?.signal,
        );
        return { ok: true, accepted: value?.accepted === true };
      } catch (error) {
        return fail("prompt-failed", String(error?.message ?? error));
      }
    },
  });

  // ── dsh_session_read ─────────────────────────────────────────────────────
  register({
    name: "dsh_session_read",
    description:
      "读一个会话的转录：用户消息、助手回复、工具调用与结果。" +
      "waitMs 大于 0 时会等到当前回合结束再返回，适合「发完提示词然后等结果」这种用法。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, description: "目标会话 id" },
        waitMs: {
          type: "integer",
          minimum: 0,
          maximum: 600000,
          description: "等待当前回合结束的上限（毫秒）；0 表示立刻返回",
        },
        maxMessages: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "最多回给模型的消息条数（默认 40）",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    async execute(input, execution) {
      const sessionController = service(ctx, "sessionController");
      if (!sessionController) {
        return fail("no-session-controller", "宿主服务 sessionController 不可用");
      }
      try {
        const waitMs = Number.isInteger(input?.waitMs) ? input.waitMs : 0;
        const inspection = await waitForTurn(
          sessionController,
          input.sessionId,
          waitMs,
          execution?.signal,
        );
        const events = inspection?.events ?? [];
        const transcript = transcribe(events);
        const limit = Number.isInteger(input?.maxMessages) ? input.maxMessages : 40;
        const truncated = transcript.messages.length > limit;
        const messages = truncated ? transcript.messages.slice(-limit) : transcript.messages;
        const running = events.some((event) => event?.type === "turn/start") &&
          !events.some((event) => event?.type === "turn/end");
        return {
          ok: true,
          meta: inspection?.meta
            ? {
                id: inspection.meta.id,
                agentPreset: inspection.meta.agentPreset ?? null,
                cwd: inspection.meta.cwd ?? null,
                createdAt: inspection.meta.createdAt ?? null,
              }
            : null,
          running,
          truncated,
          transcript: { ...transcript, messages },
        };
      } catch (error) {
        return fail("read-failed", String(error?.message ?? error));
      }
    },
  });

  // ── dsh_session_cancel ───────────────────────────────────────────────────
  register({
    name: "dsh_session_cancel",
    description: "取消一个会话当前正在跑的回合（不丢它的待办队列）。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, description: "目标会话 id" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    async execute(input) {
      const sessionController = service(ctx, "sessionController");
      if (!sessionController) {
        return fail("no-session-controller", "宿主服务 sessionController 不可用");
      }
      try {
        const value = sessionController.cancel({ sessionId: input.sessionId });
        return { ok: true, accepted: value?.accepted === true };
      } catch (error) {
        return fail("cancel-failed", String(error?.message ?? error));
      }
    },
  });

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}
