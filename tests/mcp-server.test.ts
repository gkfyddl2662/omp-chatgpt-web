import assert from "node:assert/strict";
import test from "node:test";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMcpServer } from "../src/mcp-server.js";
import { TurnBroker } from "../src/turn-broker.js";

const tools: Tool[] = [{
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  } as Tool["parameters"],
}];

async function rpc(url: string, id: number, method: string, params: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return await response.json() as Record<string, any>;
}


test("supports MCP 2026-07-28 server/discover", async (t) => {
  const broker = new TurnBroker();
  const server = await createMcpServer({ host: "127.0.0.1", port: 0, broker });
  t.after(() => server.close());

  const discover = await rpc(server.url, 100, "server/discover", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "ChatGPT",
        version: "test",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });

  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discover.result.capabilities, { tools: {} });
  assert.equal(
    discover.result._meta["io.modelcontextprotocol/serverInfo"].name,
    "omp-chatgpt-web",
  );
});


test("emits 2026-07-28 result envelopes for tools/list and tools/call", async (t) => {
  const broker = new TurnBroker();
  const { token } = broker.begin("modern", tools);
  const server = await createMcpServer({ host: "127.0.0.1", port: 0, broker });
  t.after(() => server.close());

  const meta = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "ChatGPT", version: "test" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };

  const list = await rpc(server.url, 110, "tools/list", meta);
  assert.equal(list.result.resultType, "complete");
  assert.equal(list.result.ttlMs, 0);
  assert.equal(list.result.cacheScope, "private");

  const inventory = await rpc(server.url, 111, "tools/call", {
    ...meta,
    name: "omp_tool_inventory",
    arguments: { turn_token: token },
  });
  assert.equal(inventory.result.resultType, "complete");
  assert.equal(inventory.result.structuredContent.tools[0].name, "read");
});

test("fixed MCP ABI inventories and invokes turn-local OMP tools", async (t) => {
  const broker = new TurnBroker({ toolTimeoutMs: 2_000 });
  const { token } = broker.begin("s", tools);
  const server = await createMcpServer({ host: "127.0.0.1", port: 0, broker });
  t.after(() => server.close());

  const list = await rpc(server.url, 1, "tools/list", {});
  const names = list.result.tools.map((tool: any) => tool.name);
  assert.deepEqual(names, ["omp_tool_inventory", "omp_tool_call", "omp_turn_complete"]);

  const inventory = await rpc(server.url, 2, "tools/call", {
    name: "omp_tool_inventory",
    arguments: { turn_token: token },
  });
  assert.equal(inventory.result.structuredContent.tools[0].name, "read");

  const callPromise = rpc(server.url, 3, "tools/call", {
    name: "omp_tool_call",
    arguments: { turn_token: token, name: "read", arguments: { path: "README.md" } },
  });
  const action = await broker.nextAction("s");
  assert.equal(action.type, "tool");
  if (action.type !== "tool") throw new Error("expected tool action");

  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: action.toolCallId,
    toolName: action.name,
    content: [{ type: "text", text: "hello" }],
    isError: false,
    timestamp: Date.now(),
  };
  broker.settleToolResult("s", result);
  const called = await callPromise;
  assert.equal(called.result.structuredContent.tool, "read");
  assert.equal(called.result.structuredContent.is_error, false);
});

test("turn completion asks ChatGPT to render the same final answer visibly", async (t) => {
  const broker = new TurnBroker();
  const { token } = broker.begin("complete-visible", tools);
  const server = await createMcpServer({ host: "127.0.0.1", port: 0, broker });
  t.after(() => server.close());

  const completed = await rpc(server.url, 200, "tools/call", {
    name: "omp_turn_complete",
    arguments: {
      turn_token: token,
      answer: "final answer from OMP",
    },
  });

  assert.equal(
    completed.result.structuredContent.render_final_answer_in_chat,
    true,
  );
  assert.match(
    completed.result.content[0].text,
    /render exactly the same final answer/i,
  );

  const action = await broker.nextAction("complete-visible");
  assert.deepEqual(action, {
    type: "complete",
    token,
    answer: "final answer from OMP",
  });
});
