import assert from "node:assert/strict";
import test from "node:test";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { TurnBroker } from "../src/turn-broker.js";

const tools: Tool[] = [{
  name: "goal",
  description: "Manage the active Goal",
  parameters: {
    type: "object",
    properties: { op: { type: "string" } },
    required: ["op"],
  } as Tool["parameters"],
}];

test("inventory exposes the current OMP tool schema", () => {
  const broker = new TurnBroker();
  const { token } = broker.begin("session-1", tools);
  const page = broker.inventory(token, { includeSchema: true });
  assert.equal(page.total, 1);
  assert.equal(page.tools[0]?.name, "goal");
  assert.equal(page.tools[0]?.parameters.type, "object");
});

test("inventory treats multi-keyword queries as resilient search terms", () => {
  const broker = new TurnBroker();
  const searchTools: Tool[] = [
    {
      name: "read",
      description: "Read a file from disk",
      parameters: {} as Tool["parameters"],
    },
    {
      name: "write",
      description: "Write content to a file",
      parameters: {} as Tool["parameters"],
    },
    {
      name: "grep",
      description: "Search file contents",
      parameters: {} as Tool["parameters"],
    },
  ];
  const { token } = broker.begin("inventory-search", searchTools);

  const separateTerms = broker.inventory(token, {
    query: "write read",
    includeSchema: false,
  });
  assert.deepEqual(
    separateTerms.tools.map(tool => tool.name),
    ["read", "write"],
  );

  const allTerms = broker.inventory(token, {
    query: "read file",
    includeSchema: false,
  });
  assert.deepEqual(
    allTerms.tools.map(tool => tool.name),
    ["read"],
  );

  const exactPhrase = broker.inventory(token, {
    query: "file contents",
    includeSchema: false,
  });
  assert.deepEqual(
    exactPhrase.tools.map(tool => tool.name),
    ["grep"],
  );
});

test("MCP request becomes an outer OMP action and resolves from its native ToolResult", async () => {
  const broker = new TurnBroker({ toolTimeoutMs: 2_000 });
  const { token } = broker.begin("session-1", tools);

  const receiptPromise = broker.requestTool(token, "goal", { op: "get" });
  const action = await broker.nextAction("session-1");
  assert.equal(action.type, "tool");
  if (action.type !== "tool") throw new Error("expected tool action");
  assert.equal(action.name, "goal");
  assert.deepEqual(action.arguments, { op: "get" });

  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: action.toolCallId,
    toolName: "goal",
    content: [{ type: "text", text: '{"status":"active"}' }],
    isError: false,
    timestamp: Date.now(),
  };
  assert.equal(broker.settleToolResult("session-1", result), true);
  const receipt = await receiptPromise;
  assert.equal(receipt.tool, "goal");
  assert.equal(receipt.is_error, false);
});

test("turn completion is delivered to the provider side", async () => {
  const broker = new TurnBroker();
  const { token } = broker.begin("session-1", tools);
  broker.complete(token, "done");
  const action = await broker.nextAction("session-1");
  assert.deepEqual(action, { type: "complete", token, answer: "done" });
});
