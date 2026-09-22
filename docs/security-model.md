# Security model

## Trust boundary

ChatGPT is allowed to **request** tool execution. OMP remains the authority that
decides whether the requested action can run.

The Secure MCP Tunnel is transport, not the authorization boundary.

## Required invariants

1. Every MCP request carries an opaque turn-scoped capability.
2. A capability resolves to exactly one live OMP session/turn.
3. Aborted/completed turns revoke their capabilities.
4. Unknown/expired capabilities fail closed.
5. OMP approval policy remains authoritative for mutating or dangerous tools.
6. MCP must not bypass OMP tool hooks or validation.
7. Internal OMP handles, filesystem roots, and runtime objects are not encoded
   into capability tokens.
8. Model inference never falls back to Codex, Work, or OpenAI API inference.

## Concurrency

Multiple OMP sessions and ChatGPT tabs may coexist. A tool call for session A
must never resolve against session B's runtime.

The capability broker is therefore the mandatory routing layer between MCP and
OMP tools.

## Cancellation

Cancellation should propagate in this direction:

```text
OMP abort
 -> revoke capability / abort signal
 -> pending MCP execution stops
 -> browser turn is cancelled
```

A late MCP call after revocation must return an explicit expired-capability
error and perform no side effect.

## Approval

The target behavior is:

```text
ChatGPT requests exec(...)
 -> MCP call waits
 -> OMP evaluates policy / prompts user when required
 -> OMP executes or denies
 -> result returns through MCP
 -> ChatGPT continues the same response
```

No ChatGPT-side confirmation UI is considered a substitute for OMP's local
approval policy.
