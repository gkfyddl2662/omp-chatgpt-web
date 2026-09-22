import { createTunnelConfigFromEnv } from "./tunnel-config.js";

const hasTunnelId = Boolean(process.env.OPENAI_MCP_TUNNEL_ID);
const hasRuntimeKey = Boolean(process.env.OPENAI_MCP_RUNTIME_KEY);

if (!hasTunnelId || !hasRuntimeKey) {
  console.log(JSON.stringify({
    tunnel: {
      idConfigured: hasTunnelId,
      runtimeKeyConfigured: hasRuntimeKey,
      command: process.env.OMP_MCP_COMMAND ?? "omp-chatgpt-web-mcp",
    },
    status: "missing-secure-tunnel-config",
    required: [
      "OPENAI_MCP_TUNNEL_ID",
      "OPENAI_MCP_RUNTIME_KEY",
    ],
  }, null, 2));
  process.exitCode = 1;
} else {
  const config = createTunnelConfigFromEnv();

  console.log(JSON.stringify({
    tunnel: {
      idConfigured: Boolean(config.tunnelId),
      runtimeKeyConfigured: Boolean(config.runtimeKey),
      command: config.command,
    },
    status: "secure-tunnel-config-ok",
  }, null, 2));
}
