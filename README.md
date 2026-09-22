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

Implemented on the bootstrap branch:

- fail-closed backend policy
- browser-level guard against direct OpenAI API inference and Codex/Work navigation
- turn-scoped capability broker skeleton
- minimal managed Chrome/Edge runtime for normal ChatGPT Temporary Chat
- login/check/chat CLI probes
- Windows verification scripts that copy full results to the clipboard
- architecture/security documents and phased roadmap

The current browser runtime is a Phase 1 probe. It is not yet wired into OMP's custom provider registry, and native MCP/tunnel execution is not yet enabled.

The next end-to-end milestones are:

```text
OMP provider -> normal ChatGPT Web -> final text -> OMP
ChatGPT Web -> native MCP read() -> Secure MCP Tunnel -> OMP
```

See:

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Roadmap](docs/roadmap.md)
- [Windows local validation](docs/local-validation.md)
