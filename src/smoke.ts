import assert from "node:assert/strict";
import { assertAllowedInferenceBackend } from "./backend-policy.js";
import { CapabilityBroker } from "./capability-broker.js";
import { classifyBrowserRequest } from "./chatgpt-web/network-policy.js";
import type { OmpToolRuntime, ToolExecutionResult } from "./types.js";

assertAllowedInferenceBackend({ kind: "chatgpt-web", surface: "normal-chat" });
assert.throws(
  () => assertAllowedInferenceBackend({ kind: "codex" }),
  /Forbidden inference backend/,
);

assert.deepEqual(
  classifyBrowserRequest("https://chatgpt.com/backend-api/conversation"),
  { allowed: true },
);
assert.equal(
  classifyBrowserRequest("https://api.openai.com/v1/responses").allowed,
  false,
);
assert.equal(
  classifyBrowserRequest("https://chatgpt.com/codex", { navigation: true }).allowed,
  false,
);
assert.equal(
  classifyBrowserRequest("https://chatgpt.com/work", { navigation: true }).allowed,
  false,
);

const runtime: OmpToolRuntime = {
  listTools() {
    return [
      {
        name: "read",
        description: "Smoke-test tool",
        inputSchema: { type: "object" },
      },
    ];
  },

  async invokeTool(request): Promise<ToolExecutionResult> {
    return {
      isError: false,
      content: [{ type: "text", text: `${request.name}:${request.callId}` }],
    };
  },
};

const controller = new AbortController();
const broker = new CapabilityBroker();
const token = broker.bind({
  sessionId: "smoke-session",
  turnId: "smoke-turn",
  cwd: process.cwd(),
  runtime,
  signal: controller.signal,
  createdAt: Date.now(),
});

const tools = await broker.listTools(token);
assert.equal(tools.length, 1);
assert.equal(tools[0]?.name, "read");

const result = await broker.invoke(token, {
  callId: "call-1",
  name: "read",
  arguments: { path: "README.md" },
});
assert.equal(result.isError, false);
assert.equal(result.content[0]?.type, "text");

controller.abort();
await assert.rejects(
  () =>
    broker.invoke(token, {
      callId: "call-after-abort",
      name: "read",
      arguments: {},
    }),
  /Unknown or expired turn capability|aborted/,
);

console.log("bootstrap smoke verification: PASS");
