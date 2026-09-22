export interface SecureMcpTunnelConfig {
  tunnelId: string;
  runtimeKey: string;
  command: string;
  args: string[];
}

/**
 * OpenAI Secure MCP Tunnel is transport only. The authorization boundary
 * remains inside the OMP capability broker.
 */
export function createTunnelConfigFromEnv(): SecureMcpTunnelConfig {
  return {
    tunnelId: requireEnv("OPENAI_MCP_TUNNEL_ID"),
    runtimeKey: requireEnv("OPENAI_MCP_RUNTIME_KEY"),
    command: process.env.OMP_MCP_COMMAND ?? "omp-chatgpt-web-mcp",
    args: [],
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Secure MCP Tunnel mode.`);
  return value;
}
