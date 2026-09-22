# Architecture

## Goal

Run **Oh My Pi as the agent harness** while using **normal ChatGPT Web chat** as
the only model-inference backend. ChatGPT invokes local OMP capabilities through
its **native MCP tool-calling path**, transported by OpenAI's Secure MCP Tunnel.

Codex and ChatGPT Work are explicitly out of scope and must not be used as
fallback inference routes.

```text
Oh My Pi
  TUI / session / context / approvals
               |
               | prompt + compiled context
               v
omp-chatgpt-web provider/runtime
               |
               | browser-owned normal ChatGPT Web chat
               v
          ChatGPT Web
               |
               | native MCP call
               v
      ChatGPT custom connector
               |
               | OpenAI Secure MCP Tunnel
               v
         tunnel-client
               |
               | stdio MCP
               v
      OMP capability broker
               |
               v
       current OMP turn tools
```

## Single tool-call path

There must be exactly one local tool-call path while this backend is active:

```text
ChatGPT Web -> native MCP -> OMP capability broker -> OMP tool runtime
```

The provider must **not** emulate OpenAI function calls by asking the model to
print JSON. It also must not expose a second Responses/function-call loop to OMP.

A ChatGPT turn may perform multiple MCP rounds before returning final text:

```text
user
 -> OMP
 -> ChatGPT Web
 -> MCP read
 <- result
 -> MCP edit
 <- result
 -> MCP exec
 <- result
 -> final assistant text
 -> OMP
```

## Capability binding

Every outer OMP turn receives a cryptographically random opaque capability
token. The token maps privately to:

- OMP session id
- OMP turn id
- current cwd/workspace boundary
- active tool runtime
- approval policy/runtime context
- cancellation signal

Only the opaque token crosses into the ChatGPT/MCP surface. Internal OMP
session handles are never exposed.

Capabilities are revoked when the turn aborts or completes.

## OMP integration boundary

The desired OMP-side abstraction is a reusable dispatcher around the current
session tool registry:

```ts
interface OmpToolRuntime {
  listTools(): ToolDefinition[];
  invokeTool(request, { signal, onUpdate }): Promise<ToolExecutionResult>;
}
```

The final implementation should reuse OMP's existing tool execution pipeline
instead of calling tool implementations directly. That preserves:

- argument validation
- user approval policy
- tool lifecycle events
- extension hooks
- streaming updates
- cancellation
- custom tools
- OMP-connected MCP tools

OMP's existing Cursor execution bridge already demonstrates registry-driven
tool lookup/execution and should be used as a reference when extracting a
general dispatcher.

## MCP ABI

V1 should expose a deliberately small hot path:

- `read`
- `grep`
- `glob`
- `edit`
- `write`
- `exec`

Then add dynamic access:

- `list_tools`
- `call_tool`

Dynamic dispatch lets installed OMP extensions and downstream MCP tools become
available without hard-coding each one into this project.

## Browser runtime

The browser side should reuse the proven ideas from `codex-chatgpt-web`:

- persistent authenticated browser partition
- normal ChatGPT Temporary Chat
- task-bound browser surface
- logical turn identity rather than fragile display indexes
- model/mode selection through the normal ChatGPT chat UI
- cancellation propagation
- no profile/cookie handoff if avoidable

Only the ChatGPT Web runtime and MCP/tunnel mechanics are reusable concepts.
Codex-specific Responses proxying, config integration, model routing, and Codex
tool protocols are not part of this project.

## Fail-closed inference policy

Allowed:

```text
normal ChatGPT Web chat
```

Forbidden:

```text
Codex inference
ChatGPT Work
OpenAI API model inference
silent provider fallback
quota-bypass retries through another product surface
```

A ChatGPT Web quota/auth/runtime failure ends the turn with an explicit error.
It must never trigger a fallback to another inference backend.
