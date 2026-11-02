# dsh-session-bridge

Let a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent open
**foreground** sessions, drive them, and read the result back — and hand out the
authenticated URL of the local web app.

## Why

The Host already has everything needed: `ctx.sessionController` can create, prompt,
inspect and cancel a session, and `ctx.connection.authenticatedUrl()` returns the
web app URL carrying a launch token. None of it is reachable from a model tool.

Without this plugin, an agent that wants to verify something in a real foreground
session has to:

1. dig a `dsh-auth-*` cookie out of Chromium's cookie store — and guess which one
   matches the current port, because the token encodes `authority: 127.0.0.1:<port>`;
2. reverse-engineer the `/api/*` RPC envelope and its `_request` argument shape;
3. poke the DOM to get text into the composer, then read the rendered transcript.

Each of those is one tool call here.

## Tools

| Tool | What it does |
| --- | --- |
| `dsh_web_url` | The local web GUI URL. Masks the launch token by default; pass `includeToken: true` to get a browser-usable URL. |
| `dsh_session_create` | Create a foreground session. Returns its id. |
| `dsh_session_prompt` | Send a prompt to a session (`queue` or `steer`). |
| `dsh_session_read` | Read a session's transcript. `waitMs` waits for the current turn to finish. |
| `dsh_session_cancel` | Cancel a session's running turn. |

### Token handling in `dsh_web_url`

The launch token minted by `connection.authenticatedUrl()` is a live credential:
any browser that opens the URL gets an authenticated session. A tool result also
lands in the conversation transcript, and from there into logs, exports and any
copy of the chat.

So the default is `maskToken`: the tool returns `origin` plus a URL whose token is
reduced to its first and last four characters. Pass `includeToken: true` only when
something actually needs to open a browser, and do not persist or paste the result.

## Foreground vs delegated

This is the part that matters. A **foreground** session is a root agent: it has
the `userQuestions` service, so a plugin that needs human consent can actually
ask. A **delegated** task (a subagent, a workflow agent) does not, and gets:

```
APP_APPROVAL_UNAVAILABLE: Application approval is unavailable in delegated tasks; ask the main task to perform this operation
```

So plugins like [dsh-cua-macos](https://github.com/elfgzp/dsh-cua-macos) can only
be exercised end to end from a foreground session — which is exactly what these
tools create.

## Install

```sh
dsh plugin --profile <profile> add github:elfgzp/dsh-session-bridge
```

Restart DSH afterwards. The plugin has no dependencies.

## Example

```
你手上有一个只能在前台会话里验证的功能。请：
1. 用 dsh_session_create 建一个会话
2. 用 dsh_session_prompt 让它做那件事
3. 用 dsh_session_read（waitMs=120000）把结果读回来
```

## Notes

- `dsh_session_read` truncates long text and returns at most `maxMessages`
  messages (default 40). Read a long session in pieces.
- The transcript includes tool calls and their results, so a session that used
  other tools is still auditable from here.
- `dsh_web_url` needs the `webApp` service; a headless deployment has none and
  the tool says so instead of failing.

## License

MIT — see [LICENSE](LICENSE).
