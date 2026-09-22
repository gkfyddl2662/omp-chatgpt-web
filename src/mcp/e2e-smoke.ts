import assert from "node:assert/strict";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";

const { mcp, broker, contexts } = createBootstrapRuntime();
const controller = new AbortController();
const capability = "smoke-capability";

contexts.register({
  token: capability,
  sessionId: "smoke-session",
  turnId: "smoke-turn",
  cwd: process.cwd(),
});

broker;

const result = await mcp.callTool(capability, {
  callId: "read-smoke",
  name: "read",
  arguments: {
    path: "README.md",
  },
});

assert.equal(result.isError, false);
assert.equal(result.content[0]?.type, "text");
controller.abort();

console.log("MCP read smoke: PASS");
