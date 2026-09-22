import assert from "node:assert/strict";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

const { mcp, contexts } = createBootstrapRuntime();
const protocol = new OmpMcpProtocolServer(mcp);

const capability = "stdio-smoke-capability";
contexts.register({
  token: capability,
  sessionId: "stdio-session",
  turnId: "stdio-turn",
  cwd: process.cwd(),
});

const initialize = await protocol.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
});

assert.equal(initialize.jsonrpc, "2.0");
assert.equal((initialize.result as any).serverInfo.name, "omp-chatgpt-web");

const tools = await protocol.handle({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: { capability },
});

assert.equal(Array.isArray((tools.result as any).tools), true);
assert.equal((tools.result as any).tools[0].name, "read");

console.log("mcp protocol smoke verification: PASS");
