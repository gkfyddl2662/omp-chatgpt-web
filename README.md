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

See `docs/architecture.md` once the bootstrap branch lands.
