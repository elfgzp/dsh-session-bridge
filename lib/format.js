/**
 * dsh-session-bridge 的纯函数层。
 *
 * 这里只放「输入 → 输出」的确定性函数（外加一个只依赖注入进来的
 * sessionController 的轮询等待），不 import 任何宿主包、不碰 ctx。
 * 这样它既可以在插件里复用，也可以被 node:test 直接测试。
 *
 * 约定：本文件所有导出都是具名导出，且自带 JSDoc 说明参数形状。
 */

/** 单条消息最多回给模型多少字符，避免一次读回把上下文撑爆。 */
export const MAX_TEXT = 4000;

/** tool/call 的 arguments 最多回给模型多少字符。 */
export const MAX_ARGS = 1200;

/**
 * 从 ContentBlock[] 里抽出纯文本。
 *
 * @param {readonly any[]} content 内容块数组
 * @returns {string} 拼接后的文本；非数组按空处理
 */
function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * 截断长文本，保留头尾并标注省略量。
 *
 * 头留 70%、尾留 20%，中间用一行中文省略标记补齐，这样模型既能看到
 * 开头（通常是结论/标题）也能看到结尾（通常是错误栈尾或结果）。
 *
 * @param {unknown} text 待截断内容；非字符串先 String() 化
 * @param {number} [limit] 目标长度上限，默认 MAX_TEXT
 * @returns {string} 原样或截断后的文本
 */
export function clip(text, limit = MAX_TEXT) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= limit) return value;
  const head = value.slice(0, Math.floor(limit * 0.7));
  const tail = value.slice(-Math.floor(limit * 0.2));
  return `${head}\n…（省略 ${value.length - head.length - tail.length} 字符）…\n${tail}`;
}

/**
 * 把 URL 里的启动 token 打码，只保留可读的主机与路径。
 *
 * token 是活凭据，一旦进了聊天记录就等于泄露，所以默认不返回明文。
 * 保留首尾各 4 个字符是为了让人能比对「是不是同一个」，但不足以复用。
 *
 * @param {string} url 完整 URL
 * @returns {string} 打码后的 URL；解析失败时用正则兜底
 */
export function maskToken(url) {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token");
    if (!token) return url;
    // 用 ASCII 省略号：… 会被 URL 编码成 %E2%80%A6，不可读。
    const shown =
      token.length <= 12 ? "***" : `${token.slice(0, 4)}...${token.slice(-4)}`;
    parsed.searchParams.set("token", shown);
    // URL 会把 * 原样保留；这里手工拼，避免 searchParams 重新编码。
    return parsed.toString().replace(encodeURIComponent(shown), shown);
  } catch {
    return url.replace(/([?&]token=)[^&]+/, "$1***");
  }
}

/**
 * 把 turn/end 的 reason（一个 {kind:...} 对象）压成短标签。
 *
 * 形状来自宿主的 TurnEndReason：
 *   { kind: "completed" }
 *   { kind: "aborted", reason|cause: { kind: "user" } | "user" }
 *   { kind: "error", error: { message | code } }
 *
 * @param {unknown} reason turn/end 事件里的 data.reason
 * @returns {string|null} 短标签；无法识别时返回 null
 */
export function reasonLabel(reason) {
  if (typeof reason === "string") return reason;
  if (!reason || typeof reason !== "object") return null;
  const kind = typeof reason.kind === "string" ? reason.kind : null;
  if (kind === "aborted") {
    const cause = reason.reason ?? reason.cause;
    const causeKind = cause && typeof cause === "object" ? cause.kind : cause;
    return causeKind ? `aborted(${causeKind})` : "aborted";
  }
  if (kind === "error") {
    const message = reason.error?.message ?? reason.error?.code;
    return message ? `error(${message})` : "error";
  }
  return kind;
}

/**
 * 把一个会话的事件流压成模型能读的转录。
 *
 * @param {readonly any[]} [events] 会话事件
 * @returns {{ messages: any[], toolCalls: any[], turns: number, lastTurnReason: string|null }}
 *   messages 只含非空文本；toolCalls 同时收 tool/call 与 tool/result；
 *   turns 取所有 turn/end 的最大 turn；lastTurnReason 取最后一个 turn/end 的标签。
 */
export function transcribe(events) {
  const messages = [];
  const toolCalls = [];
  let turns = 0;
  let lastTurnReason = null;

  for (const event of events ?? []) {
    const type = event?.type;
    const data = event?.data ?? {};
    switch (type) {
      case "user/message": {
        const text = textOf(data.content);
        if (text) messages.push({ role: "user", text: clip(text) });
        break;
      }
      case "assistant/message": {
        const text = textOf(data.message?.content);
        if (text) messages.push({ role: "assistant", text: clip(text) });
        break;
      }
      case "tool/call": {
        toolCalls.push({
          turn: data.turn,
          step: data.step,
          name: data.name,
          arguments: clip(data.arguments, MAX_ARGS),
        });
        break;
      }
      case "tool/result": {
        const message = data.message ?? {};
        const text = textOf(message.content);
        toolCalls.push({
          turn: data.turn,
          step: data.step,
          name: message.source?.kind === "tool" ? message.source.toolName : undefined,
          result: clip(text, MAX_ARGS),
          isError: message.isError === true,
        });
        break;
      }
      case "turn/end": {
        turns = Math.max(turns, data.turn ?? 0);
        lastTurnReason = reasonLabel(data.reason);
        break;
      }
      default:
        break;
    }
  }
  return { messages, toolCalls, turns, lastTurnReason };
}

/**
 * 等待会话里出现一个「完成」的回合。
 *
 * 判定：存在 turn/end，且它的 turn 不小于任何一条 user/message 的 turn。
 * 这样既能等到本轮跑完，又不会因为历史回合而立刻返回。
 *
 * 注意：本函数只依赖注入进来的 sessionController，不 import 宿主包，
 * 因此可以用假 controller 直接测试。
 *
 * @param {{ inspect(sessionId: string, signal?: AbortSignal): any }} sessionController 宿主服务
 * @param {string} sessionId 目标会话
 * @param {number} waitMs 等待上限（毫秒）；0 表示不等待
 * @param {AbortSignal} [signal] 取消信号
 * @param {number} [pollMs] 轮询间隔（毫秒），默认 400；测试可调小
 * @returns {Promise<any>} 最后一次 inspect 的结果
 */
export async function waitForTurn(sessionController, sessionId, waitMs, signal, pollMs = 400) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let inspection = await sessionController.inspect(sessionId, signal);

  for (;;) {
    const events = inspection?.events ?? [];
    const userTurns = events
      .filter((event) => event?.type === "user/message")
      .map((event) => event?.data?.turn ?? 0);
    const needed = userTurns.length > 0 ? Math.max(...userTurns) : 0;
    const finished = events.some(
      (event) => event?.type === "turn/end" && (event?.data?.turn ?? 0) >= needed,
    );
    if (finished) return inspection;
    if (Date.now() >= deadline || signal?.aborted) return inspection;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    inspection = await sessionController.inspect(sessionId, signal);
  }
}
