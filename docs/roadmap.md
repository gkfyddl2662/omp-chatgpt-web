# Roadmap

## Phase 0 — bootstrap

- [x] Record non-negotiable backend/tooling invariants
- [x] Add turn capability broker skeleton
- [x] Add fail-closed inference backend policy
- [x] Wire CI/typecheck/smoke verification

## Phase 1 — ChatGPT Web backend, no tools

- [ ] Persistent browser login/runtime
- [ ] Submit OMP compiled context to normal ChatGPT Temporary Chat
- [ ] Stream final text back into OMP
- [ ] Model/mode selection
- [ ] Explicit auth/quota/runtime errors
- [ ] Network test proving zero Codex/Work/API inference calls

## Phase 2 — one native MCP tool

- [ ] OpenAI Secure MCP Tunnel supervisor
- [ ] ChatGPT custom connector setup/verification
- [ ] stdio MCP server
- [ ] Turn capability injection
- [ ] End-to-end `read` call against the current OMP session

## Phase 3 — useful coding loop

- [ ] `grep`
- [ ] `glob`
- [ ] `edit`
- [ ] `write`
- [ ] `exec`
- [ ] OMP approval UI/policy preserved
- [ ] cancellation and timeout propagation

## Phase 4 — OMP ecosystem

- [ ] Extract/reuse generic OMP tool dispatcher
- [ ] `list_tools`
- [ ] `call_tool`
- [ ] custom OMP tools
- [ ] OMP-connected MCP tools
- [ ] tool update streaming

## Phase 5 — lifecycle hardening

- [ ] concurrent OMP sessions
- [ ] concurrent browser tabs
- [ ] login expiry/re-auth
- [ ] tunnel restart
- [ ] browser crash recovery
- [ ] capability leak/replay tests

## Deferred

- subagents
- compaction optimization
- installer/updater UX
- additional operating-system packaging
