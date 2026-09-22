import { spawn, type ChildProcess } from "node:child_process";
import { createTunnelConfigFromEnv, type SecureMcpTunnelConfig } from "./tunnel-config.js";

export interface TunnelProcess {
  process: ChildProcess;
  config: SecureMcpTunnelConfig;
  stop(): Promise<void>;
}

/**
 * Starts the Secure MCP Tunnel transport process.
 *
 * If no external tunnel executable is installed, the default development
 * command resolves to the bundled stdio MCP server so the transport path can
 * still be validated locally.
 */
export function startSecureMcpTunnel(
  config: SecureMcpTunnelConfig = createTunnelConfigFromEnv(),
): TunnelProcess {
  const isLocalFallback = config.command === "omp-chatgpt-web-mcp";
  const command = isLocalFallback ? process.execPath : config.command;
  const args = isLocalFallback
    ? ["dist/mcp/stdio-main.js"]
    : config.args;

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      OPENAI_MCP_TUNNEL_ID: config.tunnelId,
      ...(config.runtimeKey
        ? { OPENAI_MCP_RUNTIME_KEY: config.runtimeKey }
        : {}),
    },
  });

  child.on("error", (error) => {
    console.error(`Secure MCP Tunnel failed to start: ${error.message}`);
  });

  return {
    process: child,
    config,
    stop: async () => {
      if (child.killed) return;
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}
