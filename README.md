# omp-chatgpt-web

Use **normal ChatGPT Web as the actual Oh My Pi model backend**.

This project is not an Oracle/subagent adapter. When `chatgpt-web/web` is selected,
OMP sends the model turn to ChatGPT Web and treats the Web response as its native
assistant response. OMP still owns the agent loop, `/goal`, approvals, session
history, and tool execution.

> Early MVP. No Codex, ChatGPT Work, or OpenAI model-inference API fallback.

## Architecture

```text
OMP TUI / /goal / session
          |
          | model request
          v
  chatgpt-web/web provider
          |
          | normal chatgpt.com
          v
     ChatGPT Web
          |
          | native MCP calls
          v
      @OMP Local
          |
          | Secure MCP Tunnel
          v
 fixed MCP bridge ABI
   ├─ omp_tool_inventory
   ├─ omp_tool_call
   └─ omp_turn_complete
          |
          v
OMP emits/executes native ToolCall
   ├─ read/edit/write/bash
   ├─ goal
   ├─ task/hub
   ├─ LSP / MCP / extensions
   └─ whatever is active this turn
          |
          | native ToolResult
          +----------------------> same ChatGPT Web response
```

The Web model does **not** invoke a Codex model and is not called by an outer
Codex model. It is the provider selected by OMP.

## Why the MCP bridge is indirect

ChatGPT caches a connector's public MCP schema, while OMP's active tool set can
change by session, mode, Goal state, installed extensions, and MCP servers.

Therefore the connector exposes a fixed ABI:

- `omp_tool_inventory(turn_token, ...)` — inspect the exact tools and schemas
  OMP made available for this turn.
- `omp_tool_call(turn_token, name, arguments)` — request one exact OMP tool.
  The provider converts this request into a normal OMP `ToolCall`; OMP executes
  it with its ordinary approvals/UI/bookkeeping.
- `omp_turn_complete(turn_token, answer)` — return the final assistant answer
  for the current OMP model turn.

This is what allows `goal` itself to stay a real OMP tool instead of being
reimplemented inside the browser bridge.

## Install

Requires a current OMP 18.2.x+ build, Node.js 22.19+, and a Chromium-family
browser.

```sh
omp install https://github.com/gkfyddl2662/omp-chatgpt-web
```

Because this installs a provider extension, restart/resume an existing session:

```text
/goal pause
/restart
/goal resume
```

## Secure MCP Tunnel setup

Install OpenAI's `tunnel-client`, create a tunnel plus runtime key, then export:

```sh
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=sk-...
```

In ChatGPT Developer Mode create a Tunnel-backed connector named exactly:

```text
OMP Local
```

or set another exact name:

```sh
export OMP_CHATGPT_WEB_CONNECTOR="My OMP"
```

Then in OMP:

```text
/web-tunnel start
/web-open
```

`/web-open` launches ordinary Chrome with a dedicated OMP profile and a local
DevTools port. It deliberately does **not** attach Playwright during sign-in.
Sign in to ChatGPT first. The provider attaches over CDP only when an actual
`chatgpt-web/web` model turn begins. This avoids Playwright's normal launch
flags (including `--no-sandbox`) on the login browser.

Chrome 136+ requires remote debugging to use a non-default `--user-data-dir`;
the extension already uses `~/.omp/chatgpt-web/chrome` for that isolated
profile.

## Select the Web model backend

Either:

```text
/web-use
```

or use the normal model selector:

```text
/model chatgpt-web/web
```

After that, a normal goal:

```text
/goal Fix the failing auth tests, verify the fix, and complete the goal.
```

uses ChatGPT Web for model inference. When ChatGPT needs a tool it calls the
`OMP Local` connector; the bridge returns a native OMP ToolCall, so OMP runs
the actual tool and sends its result back into the same Web response.

## Context compaction

OMP's normal `/compact`, automatic threshold compaction, and mid-turn
compaction remain owned by OMP.

The provider recognizes OMP's dedicated compaction summarization context and
routes those calls through a separate **text-only ChatGPT Web turn**:

```text
active OMP /goal turn ---------> ChatGPT Web + @OMP MCP
          |
          +-- compaction ------> separate Temporary Chat
                                  - no MCP connector
                                  - no tools
                                  - summary text only
                                  - closes when summary returns
```

Supported context-maintenance calls:

- full structured compaction summary
- short PR-style compaction summary
- split-turn prefix summary
- OMP handoff document generation used by the default automatic compaction fallback

These side requests do not touch the active turn broker/token, so a mid-turn
compaction cannot consume or replace the Web response that is currently waiting
on an OMP tool result. With OMP's default method order
`remote → snapcompact → handoff → shake → soft`, this text-only provider skips
the unsupported remote/snapcompact paths and can service the handoff stage
without invoking Codex or Work.

No Codex/Work/API inference backend is used for summarization either; the
summary is produced by the same normal ChatGPT Web account.

This project is intentionally text-only. Snapcompact/image transport is not a
goal for this provider.

## Commands

| Command | Purpose |
| --- | --- |
| `/web-open` | Open ordinary Chrome for manual sign-in; automation attaches later over CDP |
| `/web-use` | Switch this OMP session to `chatgpt-web/web` |
| `/web-status` | Show provider/browser/MCP/tunnel status |
| `/web-tunnel start\|stop\|status` | Manage Secure MCP Tunnel |

There is deliberately no `web_agent_run`: ChatGPT Web is the model backend,
not a child agent.

## Credentials and quota boundary

The provider registers a local sentinel credential only so OMP treats the
custom runtime model as selectable. That value is never sent to OpenAI and the
custom `streamSimple` transport ignores it.

ChatGPT authentication lives only in the dedicated persistent browser profile.

The implementation does not call:

- the Codex model backend,
- ChatGPT Work,
- OpenAI Responses/Chat Completions for inference.

It does use ChatGPT Web and the Secure MCP Tunnel control/runtime path. Normal
ChatGPT account/model/file/tool limits and ChatGPT workspace MCP permissions
still apply.

## Current MVP limitations

- Browser automation depends on the current ChatGPT composer/Apps UI and may
  require selector updates when the UI changes.
- The connector must permit the actions needed by the task. If your workspace
  requires per-call approval, either approve in the visible browser or set
  `OMP_CHATGPT_WEB_AUTO_APPROVE=1` to allow the automation to click **Allow
  once**.
- Image input is intentionally unsupported; this provider is designed for
  text/tool coding sessions and text-only compaction.
- Token usage reported to OMP is currently zero because normal ChatGPT Web does
  not expose authoritative request token accounting through this browser path.
  Goal completion works, but token-budget accounting should be treated as
  incomplete in this MVP.
- One native OMP tool call is allowed in flight per Web response. ChatGPT can
  make many sequential tool calls.
- Real-account browser + tunnel E2E smoke testing is still required before
  calling this production-ready.

See [docs/architecture.md](docs/architecture.md).
