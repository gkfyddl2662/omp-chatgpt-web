import assert from "node:assert/strict";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";

const { mcp, contexts } = createBootstrapRuntime();
const capability = "smoke-capability";

contexts.register({
  token: capability,
  sessionId: "smoke-session",
  turnId: "smoke-turn",
  cwd: process.cwd(),
});

const result = await mcp.callTool(capability, {
  callId: "read-smoke",
  name: "read",
  arguments: {
    path: "README.md",
  },
});

assert.equal(result.isError, false);
assert.equal(result.content[0]?.type, "text");

console.log("MCP read e2e smoke: PASS");
