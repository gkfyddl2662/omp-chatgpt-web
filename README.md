# omp-chatgpt-web

Use normal **ChatGPT Web** as an **Oh My Pi (OMP) model provider**, while OMP
remains the local agent loop, session owner, approval authority, and tool
runtime.

> Status: **beta**. The core provider, retained ChatGPT sessions, native OMP
> tool bridge, compaction handoff, and OMP task/subagent routing are
> implemented. Real-account browser automation still depends on the current
> ChatGPT UI and should be treated as integration-sensitive.

## What this project does

When `chatgpt-web/web` is selected, OMP sends its model turn to a normal
`chatgpt.com` Temporary Chat. ChatGPT can call the custom **OMP Local** MCP
connector, and those calls are translated back into ordinary OMP `ToolCall`
events.

```text
OMP session / Goal / task agent
          |
          | provider request
          v
   chatgpt-web/web
          |
          v
    ChatGPT Web
          |
          | native MCP
          v
      OMP Local
          |
          | Secure MCP Tunnel
          v
  shared local MCP bridge
   - omp_tool_inventory
   - omp_tool_call
   - omp_turn_complete
          |
          v
     OMP ToolCall
          |
          v
OMP validation / approval / execution
          |
          +---- ToolResult ----> same ChatGPT response
```

There is no outer Codex/Work model deciding whether to invoke ChatGPT Web.
ChatGPT Web is the selected OMP provider.

## Requirements

- Oh My Pi 18.2.x or newer
- Node.js 22.19 or newer
- Chrome, Chromium, or Brave
- a ChatGPT account that can use custom MCP apps/connectors
- OpenAI Secure MCP Tunnel `tunnel-client`
- a configured Tunnel-backed ChatGPT connector, normally named `OMP Local`

The provider is intentionally text-only. Image input and snapcompact transport
are outside its current scope.

## Install

Install directly from the repository:

```text
omp install github:gkfyddl2662/omp-chatgpt-web --force
```

Restart OMP after installing or upgrading the extension.

## Setup

### 1. Configure the Secure MCP Tunnel

Inside OMP:

```text
/web-config tunnel tunnel_...
/web-config api sk-...
```

The values are persisted outside the plugin install directory in:

```text
~/.omp/chatgpt-web/config.json
```

If `tunnel-client` is not visible to the OMP process on Windows, locate it in
PowerShell:

```powershell
(Get-Command tunnel-client -ErrorAction Stop).Source
```

Then persist the full path:

```text
/web-config tunnel-bin C:\full\path\to\tunnel-client.exe
```

The extension also probes common Go, Scoop, WinGet, Chocolatey, and
`~/.local/bin` locations before falling back to `PATH`.

Start the tunnel:

```text
/web-tunnel start
```

### 2. Create the ChatGPT connector

In ChatGPT Developer Mode, create a Tunnel-backed MCP connector named exactly:

```text
OMP Local
```

A different exact name can be persisted with:

```text
/web-config connector My OMP
```

### 3. Sign in with the dedicated browser profile

Run:

```text
/web-open
```

This opens ordinary Chrome with the dedicated profile and **without** remote
debugging or Playwright launch flags. Sign in to ChatGPT, verify the connector
is available, then close that Chrome window completely.

On the first Web-provider turn the extension reopens the same profile with a
local DevTools port and attaches Playwright over CDP.

### 4. Select the provider

```text
/web-use
```

or use OMP's normal model selector:

```text
/model chatgpt-web/web
```

After that, ordinary OMP prompts, Goals, and task agents use ChatGPT Web for
model inference.

## Retained ChatGPT sessions

Each OMP provider session owns one live ChatGPT **Temporary Chat** tab.

```text
first turn    -> full OMP context seed
later turns   -> same ChatGPT thread + OMP continuation delta
compact       -> same retained thread
summary       -> returned to OMP
after compact -> fresh replacement Temporary Chat prepared first
old tab       -> retired only after replacement is ready
next turn     -> seeds OMP's compacted context
```

Temporary Chat is intentional. The backend does not reload or rehydrate a
retained thread between turns because there is no durable conversation URL to
reconstruct safely.

The prompt contract itself is preserved between turns; performance work is
limited to browser transport and retained-session behavior.

### Long-turn browser failure recovery

Ordinary Web turns continuously watch for a new ChatGPT error/retry surface,
including the Korean `메시지 전송 시간이 초과되었습니다` state. The provider
does **not** click ChatGPT's Retry button for these failures: a long OMP turn may
already have executed side-effecting tools, so replaying the browser turn could
repeat completed work.

Instead, the active Web turn is ended as a silent, replay-suppressed,
non-retryable OMP transition. The browser page itself is preserved when it is
still alive, because it contains the exact retained history needed for the next
context-maintenance pass. OMP keeps the tool results and repository state it
already recorded.

If an OMP Goal is still active, its normal hidden Goal continuation owns the
next turn. OMP runs pre-prompt maintenance first; an oversized context can
Auto-shake and then send COMPACT directly into the same retained ChatGPT thread.
Only if that retained page cannot accept the compaction request does the
maintenance-only compaction retry in a fresh Temporary Chat.

This is intentionally different from replaying the ordinary agent turn:
ChatGPT's Retry button is never clicked automatically for the failed agent turn,
while a compaction-only request may retry because it has no OMP tool side
effects.

## Task agents and subagents

When the current parent model is `chatgpt-web/web`, the extension's
`before_subagent_spawn` hook routes OMP task/eval subagents through the same
provider as well.

The process-level runtime is shared, while browser pages remain session-local:

```text
root OMP session ---------> Temporary Chat tab A
task/scout subagent ------> Temporary Chat tab B
review subagent ----------> Temporary Chat tab C
                               |
                               v
                     shared BrowserBackend
                     shared TurnBroker
                     shared MCP :8791
                     shared Secure MCP Tunnel
```

The MCP bridge multiplexes concurrent parent/child turns by opaque
`turn_token`. A child session releases only its own browser conversation and
turn state when it exits.

### Subagent hard limit

ChatGPT Web adds a provider-side cumulative hard cap on subagent spawns because
every Web subagent owns another ChatGPT tab. The default is **4 subagents per
root OMP session**, including nested descendants.

```text
/web limit
/web limit 2
/web limit 0
/web limit off
/web limit default
```

- `/web limit N` allows at most `N` Web subagents for that root session.
- `/web limit 0` blocks all Web subagent spawning.
- `/web limit off` disables this provider hard cap.
- `/web limit default` restores the default of 4.
- Changing the limit does not erase the root session's already-used spawn
  count. The counter resets when the whole root/subagent Web session family is
  released.

This is separate from OMP's own `task.maxConcurrency` and
`task.maxRecursionDepth` controls: those govern parallelism and recursion
depth, while the Web hard limit bounds the cumulative number of child sessions.

## Tool bridge

ChatGPT sees a fixed MCP ABI instead of a permanently expanded schema for every
possible OMP tool:

- `omp_tool_inventory(turn_token, ...)` — returns the exact tool catalog and
  schemas active for this OMP turn. Its optional `query` accepts a literal
  phrase or multiple search keywords; when no tool contains all keywords, the
  inventory falls back to tools matching any keyword instead of returning an
  avoidable empty result.
- `omp_tool_call(turn_token, name, arguments)` — asks OMP to emit and execute
  one ordinary native tool call.
- `omp_turn_complete(turn_token, answer)` — completes the current OMP model
  turn with final assistant text. After success, ChatGPT is instructed to render
  that same answer as ordinary assistant prose so the retained browser thread
  remains visibly aligned with the answer OMP received.

This keeps OMP authoritative for validation, approvals, Goal state, session
persistence, extension tools, LSP tools, and other runtime behavior.

## Compaction

OMP still decides when context compaction is required.

If a retained ChatGPT thread exists, compaction reserves that thread, waits for
its previous response to **physically settle**, sends the retained-compaction
instruction into the same thread, and returns the summary to OMP. It then
prepares a fresh replacement Temporary Chat before retiring the compacted tab,
so the browser never has to close its last tab and relaunch between epochs.

Retained compaction uses the same direct composer insertion strategy as
ordinary turns (ProseMirror -> Lexical -> execCommand -> CDP).

Compaction prefers the retained ChatGPT conversation when it is still
available. **Structured context-full maintenance** may use OMP's self-contained
compaction side request in a fresh Temporary Chat if retained history is truly
unavailable. **Handoff does not use that fresh full-history fallback**: a
handoff must summarize the retained ChatGPT thread. If retained handoff cannot
be submitted, the provider returns the failure so OMP can advance to shake or
the next configured maintenance method instead of pasting an already-overflowing
history into a fresh ChatGPT tab.

Maintenance submission is also hardened against ChatGPT composer UI races. The
provider tries Enter first, briefly checks for a new user turn or generation
state, and—only when the verified maintenance draft is still present—clicks the
visible Send button as a fallback. If the draft remains unsubmitted, it is
cleared and the retained thread is preserved.

Both retained and fresh structured compaction remain fail-closed around the
returned summary: browser/server error text, maintenance-prompt echoes, and
large source-prompt replays are rejected before OMP can commit the destructive
history rewrite. After a successful compaction/handoff, a clean replacement
Temporary Chat is prepared so the next ordinary turn seeds OMP's compacted
context from scratch.

New ordinary turns are serialized behind the compaction boundary so they cannot
race the summary/reset handoff.

## Commands

Use `/web` as the normal entry point. Running `/web` with no arguments shows
the built-in help and available subcommands.

| Command | Purpose |
| --- | --- |
| `/web start` | Prepare the shared MCP/tunnel transport and switch the current session to `chatgpt-web/web` |
| `/web use` | Switch the current OMP session to `chatgpt-web/web` without explicitly starting the tunnel first |
| `/web open` | Open the dedicated browser profile for manual ChatGPT sign-in |
| `/web status` | Show browser, MCP, tunnel, subagent budget, retained-session, and preparation diagnostics |
| `/web limit [N\|off\|default]` | Show or set the cumulative Web subagent hard cap for each root session |
| `/web tunnel` | Ensure the Secure MCP Tunnel is running |
| `/web tunnel stop\|restart\|status` | Stop, restart, or inspect the Secure MCP Tunnel |
| `/web config` | Show persisted provider configuration |
| `/web set tunnel <id>` | Persist the tunnel ID |
| `/web set api <key>` | Persist the tunnel runtime API key |
| `/web set tunnel-bin <path>` | Persist an explicit `tunnel-client` executable |
| `/web set connector <name>` | Persist the exact ChatGPT connector name |
| `/web set browser <path>` | Persist an explicit browser executable |
| `/web set cdp <port>` | Persist the local Chrome DevTools port |
| `/web set subagents <count>` | Persist the Web subagent hard cap (`-1`/`off` = unlimited) |
| `/web set insert default\|editor` | Select the composer insertion strategy; `editor` is the default direct ProseMirror/Lexical path, while `default` bypasses direct-editor probing for compatibility/debugging |
| `/web unset tunnel\|api\|tunnel-bin\|connector\|browser\|subagents\|insert` | Clear a persisted value, restore the default subagent cap, or restore the default insert strategy |

The older `/web-open`, `/web-use`, `/web-status`, `/web-tunnel`, and
`/web-config` commands remain available as compatibility aliases.

### Composer insertion strategy

Direct editor insertion is the default. The provider attempts these paths in
order without changing prompt content:

```text
ProseMirror transaction
→ Lexical direct command
→ document.execCommand("insertText")
→ CDP Input.insertText fallback
```

For the current ChatGPT ProseMirror composer, the provider inserts the complete
prompt at the current selection with one `state.tr.insertText(...)`
transaction and dispatches it directly, preserving the already-selected
connector pill. Successful turns report `mode=prosemirror` in `/web status`.

A Lexical direct-command path remains as a compatibility probe for other
composer variants. If neither editor can be reached safely, the provider falls
back automatically to the older contenteditable paths. The status timing
includes a `detail=...` field so fallback reasons remain visible.

New installs and configs without an explicit insert override use `editor`.
Existing persisted `default` values are respected and continue to bypass the
direct-editor probes. The previous `lexical` and `prosemirror` values are
accepted as legacy aliases for `editor`.

To force the older insertion path for compatibility or debugging:

```text
/web set insert default
```

To return to the normal automatic strategy:

```text
/web unset insert
```

## Diagnostics

Start with:

```text
/web-status
/web-tunnel status
```

`/web-status` includes:

- MCP endpoint
- tunnel state
- Chrome/CDP attachment state
- number of tabs and retained Web sessions
- active turns and pending compactions
- shared root/subagent Web session count
- current root-session subagent usage and hard limit
- latest prompt preparation timings, insertion mode, and direct-editor probe detail

If OMP reports that `tunnel-client` cannot be found after a restart, persist
its full executable path with `/web-config tunnel-bin ...`.

If ChatGPT fails to attach **OMP Local**, the provider fails closed instead of
silently submitting the agent prompt without the connector.

## Security and execution boundary

- ChatGPT authentication stays in the dedicated local browser profile.
- The local MCP server binds to loopback.
- The Web model receives only the fixed MCP bridge contract.
- Every MCP tool call is scoped by a turn token and the tool set OMP exposed for
  that specific turn.
- `omp_tool_call` does not directly execute filesystem or shell actions; OMP
  remains the execution and approval authority.
- The provider does not use Codex, ChatGPT Work, Responses API, or Chat
  Completions API as an inference fallback.

## Known limitations

- ChatGPT Web automation depends on current composer and Apps UI structure.
- If ChatGPT's direct editor internals cannot be discovered safely, ordinary
  insertion falls back to the older contenteditable/CDP paths. A missing
  retained thread may use a fresh **maintenance-only** compaction request, but
  ordinary agent turns are never replayed into a fresh tab automatically.
- Provider token usage is reported as zero because normal ChatGPT Web does not
  expose authoritative request token accounting through this browser path.
- Only one native OMP tool call is allowed in flight per Web response; multiple
  sequential tool rounds are supported.
- Image input and snapcompact transport are not implemented.
- Real-account browser + Secure MCP Tunnel behavior cannot be fully covered by
  headless unit tests.

## Development

```sh
npm ci
npm run check
```

The check target runs TypeScript type checking and the Node test suite.

See [docs/architecture.md](docs/architecture.md) for the runtime ownership and
turn lifecycle in more detail.

## License

MIT
