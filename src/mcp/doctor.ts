import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

const runtime = createBootstrapRuntime();
const protocol = new OmpMcpProtocolServer(runtime.mcp);

const tunnel = {
  idConfigured: Boolean(process.env.OPENAI_MCP_TUNNEL_ID),
  runtimeKeyConfigured: Boolean(process.env.OPENAI_MCP_RUNTIME_KEY),
  command: process.env.OMP_MCP_COMMAND ?? "omp-chatgpt-web-mcp",
};

const tools = await protocol.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    capability: "bootstrap",
  },
});

console.log(JSON.stringify({
  tunnel,
  mcp: {
    tools,
  },
  capabilityBinding: "bootstrap-runtime-ok",
}, null, 2));
