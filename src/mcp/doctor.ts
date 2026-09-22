import { createTunnelConfigFromEnv } from "./tunnel-config.js";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

const config = createTunnelConfigFromEnv();
const runtime = createBootstrapRuntime();
const protocol = new OmpMcpProtocolServer(runtime.mcp);

const tools = await protocol.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    capability: "bootstrap",
  },
});

console.log(JSON.stringify({
  tunnel: {
    idConfigured: Boolean(config.tunnelId),
    runtimeKeyConfigured: Boolean(config.runtimeKey),
    command: config.command,
  },
  mcp: {
    tools,
  },
  capabilityBinding: "bootstrap-runtime-ok",
}, null, 2));
