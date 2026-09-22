# omp-chatgpt-web

Use **normal ChatGPT Web chat** as the model backend for **Oh My Pi**, while keeping OMP as the local agent harness and using **native ChatGPT MCP tool calls** over OpenAI's Secure MCP Tunnel.

> Early development. The project is intentionally fail-closed: no Codex, ChatGPT Work, or OpenAI API model-inference fallback is allowed.

## Project invariants

- **Inference:** normal ChatGPT Web chat only
- **Harness:** Oh My Pi
- **Tool calling:** ChatGPT native MCP only
- **MCP transport:** OpenAI Secure MCP Tunnel
- **Local execution:** OMP tool/runtime pipeline
- **Codex:** forbidden
- **ChatGPT Work:** forbidden
- **OpenAI API model inference:** forbidden
- **Fallback:** none

## Intended flow

```text
OMP
 -> normal ChatGPT Web chat
 -> native ChatGPT MCP call
 -> OpenAI Secure MCP Tunnel
 -> OMP capability broker
 -> current OMP tool runtime
 -> MCP result
 -> same ChatGPT response continues
 -> final text returns to OMP
```

The model backend and the tool path are intentionally separate. OMP does not ask the model to emit JSON tool calls, and ChatGPT Web must not silently fall back to Codex, Work, or API inference.

## Current status

The bootstrap branch contains:

- a fail-closed backend policy
- a turn-scoped capability broker skeleton
- the initial OMP tool-runtime boundary
- architecture/security documents
- an implementation roadmap

The next milestone is an end-to-end **normal ChatGPT Web -> native MCP -> OMP `read`** round trip.

See:

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Roadmap](docs/roadmap.md)
