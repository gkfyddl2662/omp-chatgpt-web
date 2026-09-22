import assert from "node:assert/strict";
import { CapabilityBroker } from "../capability-broker.js";
import { OmpNativeMcpServer } from "./omp-native-mcp-server.js";
import { McpToolCallRouter } from "./tool-call-router.js";
import { CapabilityContextRegistry } from "./capability-context.js";
import type { OmpToolRuntime } from "../types.js";

const runtime: OmpToolRuntime = {
  listTools: () => [
    {
      name: "read",
      description: "test",
      inputSchema: { type: "object" },
    },
  ],
  invokeTool: async () => ({
    isError: false,
    content: [{ type: "text", text: "ok" }],
  }),
};

const broker = new CapabilityBroker();
const controller = new AbortController();
const token = broker.bind({
  sessionId: "mcp-test",
  turnId: "mcp-test-turn",
  cwd: process.cwd(),
  runtime,
  signal: controller.signal,
  createdAt: Date.now(),
});

const contexts = new CapabilityContextRegistry();
contexts.register({
  token,
  sessionId: "mcp-test",
  turnId: "mcp-test-turn",
  cwd: process.cwd(),
});

const router = new McpToolCallRouter(contexts, broker);
const server = new OmpNativeMcpServer({ broker, router });
const tools = await server.listTools(token);
assert.equal(tools[0]?.name, "read");

const result = await server.callTool(token, {
  callId: "1",
  name: "read",
  arguments: {},
});

assert.equal(result.isError, false);
console.log("native MCP boundary smoke: PASS");
