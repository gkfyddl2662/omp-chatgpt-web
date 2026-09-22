import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

const runtime = createBootstrapRuntime();
const abort = new AbortController();
const capability = runtime.broker.bind({
  sessionId: "mcp-doctor",
  turnId: "doctor-turn",
  cwd: process.cwd(),
  runtime: runtime.runtime,
  signal: abort.signal,
  createdAt: Date.now(),
});

const tunnel = {
  idConfigured: Boolean(process.env.OPENAI_MCP_TUNNEL_ID),
  runtimeKeyConfigured: Boolean(process.env.OPENAI_MCP_RUNTIME_KEY),
  command: process.env.OMP_MCP_COMMAND ?? "omp-chatgpt-web-mcp",
};

const protocol = new OmpMcpProtocolServer(runtime.mcp);
const tools = await protocol.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    capability,
  },
});

console.log(JSON.stringify({
  tunnel,
  mcp: {
    capabilityBound: true,
    tools,
  },
  capabilityBinding: "bootstrap-runtime-ok",
}, null, 2));

runtime.broker.revoke(capability);
abort.abort();
