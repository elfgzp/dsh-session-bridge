/**
 * lib/format.js 的单元测试。
 *
 * 跑法：node --test test/*.test.mjs（package.json 的 npm test 同款）。
 * 这些用例锁的是「抽函数之前的既有行为」，防止重构时悄悄改语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ARGS,
  MAX_TEXT,
  clip,
  maskToken,
  reasonLabel,
  transcribe,
  waitForTurn,
} from "../lib/format.js";

// ── maskToken ──────────────────────────────────────────────────────────────

test("maskToken: 长 token 保留前 4 + ... + 后 4", () => {
  const masked = maskToken("http://127.0.0.1:64762/?token=abcdefghijklmnopqrst");
  assert.equal(masked, "http://127.0.0.1:64762/?token=abcd...qrst");
  // 打码结果里不能再出现完整 token。
  assert.ok(!masked.includes("abcdefghijklmnopqrst"));
});

test("maskToken: 恰好 12 字符与更短的 token 都变成 ***", () => {
  assert.equal(maskToken("http://h/?token=abcdefghijkl"), "http://h/?token=***");
  assert.equal(maskToken("http://h/?token=abcd"), "http://h/?token=***");
});

test("maskToken: 13 字符开始才露出首尾", () => {
  assert.equal(maskToken("http://h/?token=abcdefghijklm"), "http://h/?token=abcd...jklm");
});

test("maskToken: 没有 token 时原样返回", () => {
  const url = "http://127.0.0.1:64762/";
  assert.equal(maskToken(url), url);
});

test("maskToken: 非 URL 输入走正则兜底", () => {
  assert.equal(maskToken("not-a-url?token=abcdefghijklmnop"), "not-a-url?token=***");
  assert.equal(maskToken("x?token=abc&y=1"), "x?token=***&y=1");
});

test("maskToken: 非 URL 且没有 token 时原样返回", () => {
  assert.equal(maskToken("not a url at all"), "not a url at all");
});

test("maskToken: 保留其它查询参数", () => {
  const masked = maskToken("http://h/p?token=0123456789abcdef&x=1");
  assert.equal(masked, "http://h/p?token=0123...cdef&x=1");
});

// ── clip ───────────────────────────────────────────────────────────────────

test("clip: 未超限原样返回（含正好等于上限）", () => {
  assert.equal(clip("short"), "short");
  assert.equal(clip("x".repeat(10), 10), "x".repeat(10));
  assert.equal(clip(""), "");
});

test("clip: 超限含省略计数且保留头尾", () => {
  const text = "A".repeat(50) + "MID" + "B".repeat(50); // 103 字符
  const limited = clip(text, 20);
  // head = floor(20*0.7)=14，tail = floor(20*0.2)=4，省略 = 103-14-4 = 85
  assert.ok(limited.startsWith("A".repeat(14)), "保留头部");
  assert.ok(limited.endsWith("B".repeat(4)), "保留尾部");
  assert.ok(limited.includes("省略 85 字符"), `应含省略计数，实际：${limited}`);
});

test("clip: 非字符串入参转字符串", () => {
  assert.equal(clip(12345), "12345");
  assert.equal(clip(true), "true");
  assert.equal(clip(null), "");
  assert.equal(clip(undefined), "");
});

test("clip: 默认上限是 MAX_TEXT", () => {
  assert.equal(clip("y".repeat(MAX_TEXT)), "y".repeat(MAX_TEXT));
  assert.ok(clip("y".repeat(MAX_TEXT + 1)).includes("省略"));
});

// ── reasonLabel ────────────────────────────────────────────────────────────

test("reasonLabel: completed 直出", () => {
  assert.equal(reasonLabel({ kind: "completed" }), "completed");
});

test("reasonLabel: aborted(user)", () => {
  assert.equal(reasonLabel({ kind: "aborted", reason: { kind: "user" } }), "aborted(user)");
  assert.equal(reasonLabel({ kind: "aborted", cause: "user" }), "aborted(user)");
  assert.equal(reasonLabel({ kind: "aborted" }), "aborted");
});

test("reasonLabel: error(msg)，退而用 code", () => {
  assert.equal(reasonLabel({ kind: "error", error: { message: "boom" } }), "error(boom)");
  assert.equal(reasonLabel({ kind: "error", error: { code: "E_BOOM" } }), "error(E_BOOM)");
  assert.equal(reasonLabel({ kind: "error" }), "error");
});

test("reasonLabel: 字符串直通", () => {
  assert.equal(reasonLabel("some-reason"), "some-reason");
});

test("reasonLabel: null / 非对象 → null，未知 kind 直出", () => {
  assert.equal(reasonLabel(null), null);
  assert.equal(reasonLabel(undefined), null);
  assert.equal(reasonLabel(42), null);
  assert.equal(reasonLabel({ kind: "interrupted" }), "interrupted");
});

// ── transcribe ─────────────────────────────────────────────────────────────

test("transcribe: user + assistant 进 messages", () => {
  const transcript = transcribe([
    { type: "user/message", data: { turn: 1, content: [{ type: "text", text: "你好" }] } },
    {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "在的" }] } },
    },
  ]);
  assert.deepEqual(transcript.messages, [
    { role: "user", text: "你好" },
    { role: "assistant", text: "在的" },
  ]);
  assert.deepEqual(transcript.toolCalls, []);
});

test("transcribe: 只有非空文本才进 messages", () => {
  const transcript = transcribe([
    { type: "user/message", data: { content: [] } },
    { type: "user/message", data: { content: [{ type: "image" }] } },
    { type: "assistant/message", data: {} },
  ]);
  assert.deepEqual(transcript.messages, []);
});

test("transcribe: tool/call 与 tool/result 进 toolCalls", () => {
  const transcript = transcribe([
    {
      type: "tool/call",
      data: { turn: 1, step: 2, name: "bash", arguments: "ls -la" },
    },
    {
      type: "tool/result",
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: "text", text: "total 0" }],
          source: { kind: "tool", toolName: "bash" },
          isError: false,
        },
      },
    },
  ]);
  assert.equal(transcript.toolCalls.length, 2);
  assert.deepEqual(transcript.toolCalls[0], {
    turn: 1,
    step: 2,
    name: "bash",
    arguments: "ls -la",
  });
  assert.deepEqual(transcript.toolCalls[1], {
    turn: 1,
    step: 2,
    name: "bash",
    result: "total 0",
    isError: false,
  });
});

test("transcribe: tool/result 的 isError 与超长截断", () => {
  const transcript = transcribe([
    {
      type: "tool/result",
      data: {
        turn: 3,
        step: 1,
        message: {
          content: [{ type: "text", text: "z".repeat(MAX_ARGS + 100) }],
          isError: true,
        },
      },
    },
  ]);
  const [call] = transcript.toolCalls;
  assert.equal(call.isError, true);
  assert.equal(call.name, undefined, "source 非 tool 时 name 为 undefined");
  assert.ok(call.result.includes("省略"));
});

test("transcribe: turn/end 设 turns 与 lastTurnReason", () => {
  const transcript = transcribe([
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/end", data: { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } } },
  ]);
  assert.equal(transcript.turns, 3, "取最大 turn");
  assert.equal(transcript.lastTurnReason, "aborted(user)", "取最后一个 turn/end");
});

test("transcribe: 空事件 → 空结果", () => {
  const empty = { messages: [], toolCalls: [], turns: 0, lastTurnReason: null };
  assert.deepEqual(transcribe([]), empty);
  assert.deepEqual(transcribe(undefined), empty);
});

test("transcribe: 未知事件类型被忽略", () => {
  assert.deepEqual(transcribe([{ type: "step/start" }, { type: "?" }, null]), {
    messages: [],
    toolCalls: [],
    turns: 0,
    lastTurnReason: null,
  });
});

// ── waitForTurn ────────────────────────────────────────────────────────────

const DONE_EVENTS = [
  { type: "user/message", data: { turn: 1 } },
  { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
];

test("waitForTurn: 已结束 → 立刻返回，只 inspect 一次", async () => {
  let calls = 0;
  const controller = {
    async inspect(sessionId) {
      calls += 1;
      assert.equal(sessionId, "s1");
      return { events: DONE_EVENTS, meta: { id: "s1" } };
    },
  };
  const started = Date.now();
  const inspection = await waitForTurn(controller, "s1", 5000, undefined, 20);
  const elapsed = Date.now() - started;
  assert.equal(calls, 1);
  assert.deepEqual(inspection.meta, { id: "s1" });
  assert.ok(elapsed < 200, `应立刻返回，实际 ${elapsed}ms`);
});

test("waitForTurn: 永不结束 → 约 waitMs 后返回", async () => {
  const waitMs = 80;
  let calls = 0;
  const controller = {
    async inspect() {
      calls += 1;
      return { events: [{ type: "user/message", data: { turn: 1 } }] };
    },
  };
  const started = Date.now();
  const inspection = await waitForTurn(controller, "s1", waitMs, undefined, 20);
  const elapsed = Date.now() - started;
  assert.equal(inspection.events.length, 1);
  assert.ok(calls > 1, `应轮询多次，实际 ${calls} 次`);
  assert.ok(elapsed >= waitMs - 15, `不应早于 waitMs 返回，实际 ${elapsed}ms`);
  assert.ok(elapsed < waitMs + 400, `应大致在 waitMs 附近返回，实际 ${elapsed}ms`);
});

test("waitForTurn: waitMs=0 → 不等，只 inspect 一次", async () => {
  let calls = 0;
  const controller = {
    async inspect() {
      calls += 1;
      return { events: [] };
    },
  };
  const inspection = await waitForTurn(controller, "s1", 0, undefined, 20);
  assert.equal(calls, 1);
  assert.deepEqual(inspection.events, []);
});

test("waitForTurn: 历史回合的 turn/end 不算本轮完成", async () => {
  let calls = 0;
  const controller = {
    async inspect() {
      calls += 1;
      return {
        events: [
          { type: "user/message", data: { turn: 2 } },
          { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }, // 旧回合
        ],
      };
    },
  };
  const started = Date.now();
  await waitForTurn(controller, "s1", 60, undefined, 20);
  const elapsed = Date.now() - started;
  assert.ok(calls > 1, "旧回合的 turn/end 不应让等待提前结束");
  assert.ok(elapsed >= 45, `应等满超时，实际 ${elapsed}ms`);
});

test("waitForTurn: signal 已 aborted → 不再轮询", async () => {
  let calls = 0;
  const controller = {
    async inspect() {
      calls += 1;
      return { events: [] };
    },
  };
  const abort = new AbortController();
  abort.abort();
  await waitForTurn(controller, "s1", 60_000, abort.signal, 20);
  assert.equal(calls, 1);
});
