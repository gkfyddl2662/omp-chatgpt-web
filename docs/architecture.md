# Architecture

## Purpose

`omp-chatgpt-web` makes normal ChatGPT Web the model transport selected by
OMP. OMP remains responsible for the agent loop, session journal, Goal state,
tool policy, approval, execution, and persistence.

The provider does not wrap ChatGPT Web behind another LLM.

## Ownership

| Responsibility | Owner |
| --- | --- |
| Model reasoning / next action | ChatGPT Web |
| Agent loop | OMP |
| Goal state and continuation | OMP |
| Tool catalog | OMP provider context |
| Tool validation and execution | OMP |
| Session history | OMP |
| ChatGPT login | dedicated persistent browser profile |
| Browser automation | shared `ChatGptBrowserBackend` |
| Local MCP bridge | shared `TurnBroker` + MCP server |
| Remote MCP transport | OpenAI Secure MCP Tunnel |

## Process-level runtime

The OMP extension can be rebound for root sessions and child task/eval sessions.
The expensive transport resources are therefore module-level singletons:

```text
shared Web runtime
  ├─ ChatGptBrowserBackend
  ├─ TurnBroker
  ├─ MCP server on 127.0.0.1:8791
  └─ TunnelSupervisor
```

Each provider conversation still owns an independent ChatGPT page:

```text
root session       -> Temporary Chat A
task/scout child   -> Temporary Chat B
review child       -> Temporary Chat C
```

This avoids duplicate MCP listeners and duplicate tunnel processes while
preserving browser-thread isolation between agents.

MCP and tunnel startup are serialized. Chrome/CDP connection startup is also
serialized so concurrent first turns cannot launch competing browser runtimes.

## Provider identity

The extension registers:

```text
provider: chatgpt-web
model:    web
api:      chatgpt-web
```

Provider request identity and retained browser conversation identity are
separate.

The provider prefers OMP's `promptCacheKey` for browser conversation ownership
because side requests may use a derived provider `sessionId` while still
belonging to the same logical OMP context epoch.

## Ordinary turn lifecycle

### 1. OMP calls the provider

OMP invokes `streamSimple` with its normal provider context:

- system prompts
- conversation messages
- currently active tools

For a new browser conversation the provider compiles the full seed prompt.
For later turns on the retained conversation it compiles the continuation
prompt.

### 2. The backend acquires the retained page

A `BrowserSession` is keyed by the stable conversation key.

The first turn creates or claims a Temporary Chat page. Later turns reuse the
same live page. Temporary Chat pages are never reloaded or rehydrated between
ordinary turns.

### 3. The exact connector is attached

Before the OMP prompt is inserted, the backend:

1. types the connector mention query
2. finds exactly one visible row matching the configured connector name
3. ensures that row is keyboard-highlighted
4. presses Enter
5. resolves the possibly replaced composer subtree again
6. verifies an exact selected-app pill with the configured connector keyword

If this proof fails, the turn fails before prompt submission.

### 4. The prompt is inserted

The provider prompt is inserted as inline composer text. Automated clipboard
paste is intentionally not used because ChatGPT may promote large automated
pastes into a separate "Pasted text" attachment.

The backend verifies the inserted content using detached DOM text inspection so
verification does not force expensive page-wide layout.

### 5. The turn token is used for MCP

The provider creates a `TurnBroker` entry and embeds its opaque token in the
turn contract.

The public MCP surface is fixed:

```text
omp_tool_inventory
omp_tool_call
omp_turn_complete
```

This fixed ABI avoids connector schema drift even though OMP's real active tool
set changes by mode, Goal state, installed extensions, LSP integrations, and
other MCP servers.

### 6. ChatGPT requests an OMP tool

`omp_tool_inventory` reads the exact tool catalog captured from OMP's current
provider context.

`omp_tool_call` does not execute the tool directly. It queues a broker action.
The provider emits a normal assistant `ToolCall` back into OMP with
`stopReason: "toolUse"`.

OMP then performs its ordinary validation, approvals, tool lifecycle, execution,
UI rendering, Goal updates, and persistence.

### 7. OMP returns the native ToolResult

OMP invokes the provider again with the new `ToolResultMessage`.

The provider matches the pending OMP tool call and settles the blocked MCP
request. ChatGPT therefore continues the same browser response instead of
starting another browser prompt for each tool round.

### 8. ChatGPT completes the model turn

When ChatGPT calls:

```text
omp_turn_complete(turn_token, answer)
```

the broker exposes the final text to the provider.

OMP receives the logical final answer immediately. Browser ownership is kept
until the ChatGPT UI **physically settles** and the stop-generating control has
remained absent. This physical-settlement tail happens in the background.

A following ordinary turn and retained compaction both wait for this physical
ownership to clear, preventing a new request from racing the previous browser
response.

If physical settlement never occurs after a logical
`omp_turn_complete`, the session is invalidated because the completion state is
ambiguous. A different case applies when ChatGPT itself shows a terminal
error/retry surface before OMP completion: the provider suppresses replay of the
agent turn but preserves the live retained page for context maintenance. The
next compaction snapshots that pre-existing error UI as baseline and sends the
COMPACT request into the same thread first.

## Retained conversation model

The browser backend keeps one live Temporary Chat per OMP provider conversation.

```text
epoch start
  -> full OMP seed

ordinary continuation
  -> same page
  -> continuation prompt

compact
  -> same retained thread
  -> direct-editor compaction prompt insertion
  -> summary returned to OMP
  -> fresh replacement page prepared
  -> old compacted page retired

next epoch
  -> full compacted OMP seed
```

The thread is not assumed to be recoverable after page/browser loss. Temporary
Chat has no durable conversation URL, so the provider fails over to a fresh
context rather than attempting history reconstruction.

## Compaction

OMP remains authoritative for deciding **when** compaction is necessary.

The provider recognizes OMP's summarization/handoff request shapes. If a usable
retained browser session exists, compaction:

1. reserves the conversation with a per-session barrier
2. waits for the previous browser turn to physically settle
3. inserts a short retained-compaction instruction with the same
   ProseMirror/Lexical/execCommand/CDP strategy used by ordinary turns
4. waits for the summary
5. returns the summary to OMP
6. prepares a fresh replacement Temporary Chat
7. swaps session ownership to the ready replacement, then retires the old page
8. releases the barrier

New ordinary turns wait behind this boundary.

If the retained conversation is unavailable or becomes invalid while the
compaction waits for the prior turn to settle, the backend switches to a fresh
Temporary Chat and submits the **self-contained OMP compaction side request**.
That request carries the exact compaction system instructions and source
conversation produced by OMP. It is maintenance-only: no connector is attached,
no OMP tools are exposed, and the ordinary agent turn is not replayed.

Before either retained or fresh compaction can succeed, the backend checks
ChatGPT's visible error/retry UI and validates the returned text.
Browser/server error text, maintenance-prompt echoes, and large source-prompt
replays are rejected. ChatGPT's Retry action may be attempted once on the same
submitted compaction because the side request has no tool side effects; if it
still fails, the compaction fails.

Page retirement remains last-tab safe: when a stale page is Chrome's only
remaining page, the backend navigates it to `about:blank` rather than closing
it. That keeps the dedicated CDP browser alive for the next provider request.

## Subagents

When the parent session is using `chatgpt-web/web`,
`before_subagent_spawn` rewrites the child model selection to
`chatgpt-web/web`.

This means bundled agent defaults such as a scout model alias do not bypass the
Web provider for that spawn.

Each child receives its own provider session/conversation key and therefore its
own ChatGPT page, while using the same shared MCP/tunnel/browser process-level
runtime.

The broker multiplexes simultaneous parent/child MCP traffic by turn token.

## Title utility requests

OMP title generation is a UI utility request rather than an agent turn.

The provider detects OMP's title system marker and generates the short title
locally. It does not acquire a retained ChatGPT page, connector, turn token, or
tunnel round trip for this request.

## Browser lifecycle

### Manual login

`/web-open` starts ordinary Chrome with the dedicated profile and no remote
DevTools flag. Authentication therefore occurs outside Playwright automation.

### Automated provider use

The first Web-model turn reopens that same profile with the configured local CDP
port and attaches `playwright-core` via `connectOverCDP`.

One browser context is shared by all active provider sessions. Pages are owned
or reserved so simultaneous root/subagent/side requests cannot accidentally
claim the same page.

## Tunnel lifecycle

The MCP server binds only to loopback.

When tunnel credentials are configured, the shared `TunnelSupervisor` starts
`tunnel-client` with:

```text
run
--mcp.server-url <local MCP URL>
--health.listen-addr 127.0.0.1:0
--health.url-file <temporary file>
--log.level=info
```

Readiness is determined from the tunnel client's local `/readyz` endpoint.

The executable path can be persisted explicitly. Windows discovery also checks
common Go, Scoop, WinGet, Chocolatey, and user-local binary locations before
falling back to `PATH`.

## Failure policy

The provider fails closed around connector and submission state.

Examples:

- no exact connector row -> no prompt submission
- no exact selected connector pill -> no prompt submission
- failed prompt verification -> no Enter
- ambiguous failure after Enter -> invalidate the browser session
- failure before Enter -> preserve the retained page and clear only the draft
- physical turn settlement timeout -> invalidate the retained browser session

No plain-chat fallback is used for an ordinary agent turn that was expected to
have OMP Local attached.

## Security boundary

The fixed MCP bridge does not directly execute local filesystem or shell
actions.

`omp_tool_call` can only request a tool that OMP exposed for the current turn,
and OMP remains responsible for validation, approval, and execution.

Turn tokens are scoped to active broker state. Expired tokens cannot access a
later turn's tools.

The provider does not use Codex, ChatGPT Work, Responses API, or Chat
Completions API as an inference fallback.

## Known integration limits

- ChatGPT composer and Apps selectors can change without notice.
- If direct ProseMirror/Lexical discovery fails, ordinary insertion falls back
  to older contenteditable/CDP paths. Compaction may use a fresh maintenance-only
  side request when retained history is unavailable; ordinary agent-turn replay
  remains prohibited.
- ChatGPT Web does not expose authoritative token accounting through this
  browser route, so provider usage remains zero.
- The provider is text-only.
- Real-account ChatGPT + Secure MCP Tunnel behavior still requires live smoke
  testing in addition to unit/CI coverage.
