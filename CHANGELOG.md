# Changelog

All notable changes to this project are documented here.

## 0.3.0-beta.1

Initial beta of the retained ChatGPT Web provider architecture.

### Added

- `chatgpt-web/web` OMP provider backed by normal ChatGPT Web
- fixed native MCP bridge ABI:
  - `omp_tool_inventory`
  - `omp_tool_call`
  - `omp_turn_complete`
- retained one-Temporary-Chat-per-OMP-session browser ownership
- same-thread context compaction and fresh-epoch reset
- shared process-level MCP, tunnel, browser, and turn broker runtime
- OMP task/subagent routing through independent ChatGPT tabs
- exact OMP Local connector attachment verification
- persisted tunnel, connector, browser, CDP, and `tunnel-client` configuration
- Windows `tunnel-client` executable discovery
- browser preparation diagnostics through `/web-status`
- CI type checking and unit/contract tests

### Changed

- title utility requests stay local instead of acquiring a Web conversation
- compaction waits for the previous retained response to physically settle
- pre-submit browser errors preserve the existing session instead of forcing a
  new Chrome launch
- browser automation remains CDP/DOM-only; foreground-window and automated
  clipboard paste experiments were removed

### Known limitations

- ChatGPT Web UI selectors can change independently of this project
- large inline continuation prompts can be slower to inject into long retained
  pages than manual user paste
- provider token usage is not authoritatively available from ChatGPT Web
- image input and snapcompact transport are not implemented
- live ChatGPT account + Secure MCP Tunnel behavior requires integration smoke
  testing beyond unit CI
