# Architecture

## Design goal

`omp-chatgpt-web` makes ChatGPT Web a **provider transport** for OMP. It does
not add a child worker behind another model.

The ownership split is:

| Responsibility | Owner |
| --- | --- |
| LLM reasoning / next action | ChatGPT Web |
| Agent loop | OMP |
| `/goal` state and continuation | OMP |
| Tool approval and execution | OMP |
| Session history | OMP |
| Browser authentication | dedicated ChatGPT profile |
| MCP transport | OpenAI Secure MCP Tunnel |

## Turn lifecycle

### 1. OMP calls the custom provider

The extension registers `chatgpt-web/web` with a custom `streamSimple`.
OMP passes its ordinary provider `Context`:

- system prompt,
- conversation messages,
- active tools.

The provider allocates a turn token and opens a fresh ChatGPT Temporary Chat.
The complete OMP text/tool history is serialized into that prompt along with the
turn contract.

### 2. ChatGPT selects a native OMP tool

The ChatGPT conversation has the fixed `OMP Local` MCP connector attached.

The connector contract does not mirror every OMP tool. Instead ChatGPT calls:

```text
omp_tool_inventory(turn_token)
```

to inspect the current OMP tool catalog and JSON schemas.

The inventory is sourced from `Context.tools`, so it reflects the exact tools
OMP put on that model turn, including a live Goal tool when Goal mode enables it.

### 3. ChatGPT calls `omp_tool_call`

For example:

```json
{
  "turn_token": "turn_...",
  "name": "goal",
  "arguments": { "op": "get" }
}
```

The local MCP handler does **not** execute `goal`.

Instead the turn broker creates an OMP-provider action. The custom
`AssistantMessageEventStream` emits a normal assistant `ToolCall` with that
name/id/arguments and ends that provider segment with `stopReason: "toolUse"`.

### 4. OMP executes the native tool

From this point OMP sees the same tool call it would have received from any
native provider. Its ordinary agent loop performs:

- argument validation,
- approval/policy,
- tool lifecycle events,
- UI rendering,
- GoalRuntime updates,
- persistence,
- the real tool side effect.

The result becomes an ordinary `ToolResultMessage`.

### 5. The next provider segment returns the result to ChatGPT

OMP invokes `streamSimple` again with the updated context.

The provider recognizes the pending tool-call id and settles the blocked
`omp_tool_call` MCP request with the real OMP result. ChatGPT Web therefore
continues reasoning inside the **same browser response**.

No second ChatGPT prompt is submitted for each tool round.

### 6. Final answer

When ChatGPT has finished the OMP turn, it calls:

```text
omp_turn_complete(turn_token, answer)
```

The broker exposes that completion to the provider, which emits a normal
assistant text response with `stopReason: "stop"`.

The browser tab and turn capability are then retired.

## Why Goal works

Goal is not proxied or reimplemented specially.

When OMP Goal mode makes `goal` active, it appears in `Context.tools`.
Therefore:

1. `omp_tool_inventory` shows `goal`.
2. ChatGPT calls `omp_tool_call(... name="goal" ...)`.
3. OMP receives a native toolCall named `goal`.
4. OMP's own `GoalRuntime` executes it.

This keeps Goal tokens, completion semantics, continuation, persistence, and UI
inside OMP.

## Why this does not consume an outer Codex model

Once the selected model is `chatgpt-web/web`, OMP dispatches each model segment
through this extension's `streamSimple`.

There is no outer LLM deciding whether to invoke a Web worker. The Web provider
*is* the model transport.

The project contains no call to the Codex inference backend and no model request
to ChatGPT Work.

## Fixed connector ABI

ChatGPT can cache a custom connector contract by connector identity. OMP tools
are dynamic, so publishing every OMP tool directly as an MCP method would create
schema drift.

The public connector therefore remains stable:

- `omp_tool_inventory`
- `omp_tool_call`
- `omp_turn_complete`

Turn tokens prevent a stale Web conversation from invoking tools belonging to a
later OMP turn.

## Context compaction

OMP remains responsible for deciding *when* to compact. Its normal manual,
threshold, mid-turn, and idle compaction machinery operates on the OMP session
journal.

The ChatGPT Web provider has a dedicated side-channel for OMP's local
summarization calls. It recognizes the stable OMP summarization system prompt
plus the OMP handoff request shape used by automatic compaction:

- full structured summary
- short PR-style summary
- split-turn prefix summary
- handoff document generation (`toolChoice: none` + OMP's handoff marker)

Those calls bypass the turn broker entirely:

```text
OMP compaction one-shot
       |
       v
fresh Temporary Chat
       |
       | text prompt only
       | no @OMP connector
       | no MCP / no tool calls
       v
summary text
       |
       v
OMP CompactionEntry
```

The side-channel uses a separate browser page even if the same OMP session has
an active agent turn. Therefore mid-turn compaction does not settle, cancel, or
replace the active turn's pending MCP request.

The browser explicitly refuses a compaction request when the configured OMP
connector is visibly attached to that fresh composer. This keeps summarization
tool-free instead of accidentally turning it into another agent loop.

Provider token usage is still reported as zero because ChatGPT Web does not
expose authoritative accounting through this browser route. OMP's compaction
decision is not disabled by that: OMP floors provider-reported context usage
with its own stored-conversation estimate before testing the compaction
threshold.

Image/snapcompact transport is intentionally outside this provider's scope.

## Browser lifecycle

A dedicated persistent Chromium profile stores the ChatGPT login. Each active
provider turn owns one Temporary Chat page. Sequential MCP tool calls stay
inside that same response.

The browser worker fails closed when it cannot verify:

- a ChatGPT composer,
- the configured connector,
- visible connector-selected state,
- submission evidence.

It never silently downgrades to a plain chat without MCP.

## Tunnel lifecycle

The local MCP server binds to `127.0.0.1`. When tunnel credentials are present,
the extension can supervise `openai/tunnel-client` and point it at that
loopback endpoint. An externally managed tunnel can also be used.

## Security model

The Web model never receives an unrestricted local HTTP endpoint. Its calls are
scoped by a per-turn token and by the exact OMP tool set captured from the
provider context.

More importantly, `omp_tool_call` cannot directly mutate files or execute
commands. It only asks the OMP agent loop to emit a tool call; OMP remains the
execution and approval authority.

## Known gaps

- Browser selectors need real-account qualification across ChatGPT UI variants.
- Image input and snapcompact are intentionally unsupported.
- Accurate ChatGPT Web token usage is not available through this route, so this
  MVP reports zero provider token usage.
- Title/advisor side-channel calls are not yet specially optimized.
- Connector/tool round-trip deadlines must remain below the Secure MCP Tunnel
  response timeout.
