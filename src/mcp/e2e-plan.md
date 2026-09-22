# MCP end-to-end milestone

Target flow:

```text
ChatGPT Web
  -> native MCP tools/call
  -> OpenAI Secure MCP Tunnel
  -> OMP MCP stdio server
  -> capability router
  -> OMP tool runtime
  -> result
  -> ChatGPT continues response
```

Current implementation layers:

- JSON-RPC MCP protocol boundary
- stdio transport boundary
- capability broker
- capability context registry
- tool call router

Remaining integration:

1. Connect router to real OMP tool registry.
2. Start tunnel-client lifecycle.
3. Register ChatGPT custom MCP endpoint.
4. Verify `read` tool round trip.
