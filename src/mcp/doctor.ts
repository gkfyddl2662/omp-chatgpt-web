import { createTunnelConfigFromEnv } from "./tunnel-config.js";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";

const config = createTunnelConfigFromEnv();
const runtime = createBootstrapRuntime();

const tools = await runtime.mcp.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
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
