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

`/web-open` launches ordinary Chrome with a dedicated OMP profile and **no
Playwright/automation/debugging flags at all**. Sign in to ChatGPT, then close
that Chrome window completely. On the first `chatgpt-web/web` model turn, the
provider reopens the same dedicated profile with a local DevTools port and only
then attaches Playwright over CDP. This keeps Google/OpenAI sign-in outside the
automation phase and avoids Playwright's normal launch flags (including
`--no-sandbox`) on the login browser.

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

The browser backend now retains **one ChatGPT conversation tab per OMP provider
session**, following the retained-conversation ownership pattern used by
`codex-chatgpt-web`.

Ordinary OMP model turns therefore do not create a fresh ChatGPT conversation
every time:

```text
OMP session
   |
   +-- first model turn ------> retained ChatGPT tab
   |                            full OMP context seed
   |
   +-- later model turns ----> same tab / same conversation
   |                            only the new OMP turn delta
   |
   +-- /compact -------------> same retained conversation
                                compaction instruction only
                                (history is already in the thread)
             |
             +-- summary returned to OMP
             |
             +-- same browser tab is reset to a fresh Temporary Chat
                                |
                                +-- next OMP model turn seeds
                                    OMP's compacted context
```

This avoids repeatedly replaying the complete OMP history into ChatGPT while
also letting ChatGPT compact the exact conversation it actually saw.

OMP's normal `/compact`, automatic threshold compaction, split-prefix
compaction, and handoff requests are still detected by the provider. The stable
browser ownership key prefers OMP's `promptCacheKey` over the provider
`sessionId`, because OMP side requests such as handoff may use a derived
session ID while retaining the parent cache/session identity.

### Mid-turn compaction

If OMP requests compaction while the retained ChatGPT response is still inside
an MCP tool round, the same tab cannot safely accept another user message yet.
That case uses a temporary text-only side chat for the compaction request and
marks the retained conversation for reset. Once the active tool/model turn
physically settles, the retained tab is reset to a fresh chat before the next
ordinary OMP turn.

This preserves the active MCP request while keeping the post-compaction browser
state aligned with OMP's compacted context.

No Codex/Work/API inference backend is used for summarization; compaction is
still produced through normal ChatGPT Web.

This project remains intentionally text-only. Snapcompact/image transport is
not a goal for this provider.

## Commands

| Command | Purpose |
| --- | --- |
| `/web-config ...` | Persist tunnel/API/connector/browser settings outside the plugin install directory |
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
