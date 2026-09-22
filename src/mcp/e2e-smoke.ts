import assert from "node:assert/strict";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";

const { mcp, contexts, broker, runtime } = createBootstrapRuntime();
const controller = new AbortController();

const capability = broker.bind({
  sessionId: "smoke-session",
  turnId: "smoke-turn",
  cwd: process.cwd(),
  runtime,
  signal: controller.signal,
  createdAt: Date.now(),
});

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

controller.abort();

console.log("MCP read e2e smoke: PASS");
