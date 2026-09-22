import assert from "node:assert/strict";
import { CapabilityBroker } from "../capability-broker.js";
import { OmpNativeMcpServer } from "./omp-native-mcp-server.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

const broker = new CapabilityBroker();
const server = new OmpNativeMcpServer({ broker });
const protocol = new OmpMcpProtocolServer(server);

const initialize = await protocol.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
});

assert.equal(initialize.jsonrpc, "2.0");
assert.equal((initialize.result as any).serverInfo.name, "omp-chatgpt-web");

const missing = await protocol.handle({
  jsonrpc: "2.0",
  id: 2,
  method: "unknown",
});

assert.equal(missing.error?.code, -32601);

console.log("mcp protocol smoke verification: PASS");
