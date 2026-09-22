import { spawn, type ChildProcess } from "node:child_process";
import { createTunnelConfigFromEnv, type SecureMcpTunnelConfig } from "./tunnel-config.js";

export interface TunnelProcess {
  process: ChildProcess;
  config: SecureMcpTunnelConfig;
  stop(): Promise<void>;
}

/**
 * Starts the external Secure MCP Tunnel transport process.
 *
 * The tunnel only transports MCP stdio. Authorization remains local in the
 * capability broker.
 */
export function startSecureMcpTunnel(
  config: SecureMcpTunnelConfig = createTunnelConfigFromEnv(),
): TunnelProcess {
  const child = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      OPENAI_MCP_TUNNEL_ID: config.tunnelId,
      OPENAI_MCP_RUNTIME_KEY: config.runtimeKey,
    },
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
