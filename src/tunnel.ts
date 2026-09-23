import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeConfig } from "./config.js";

export interface TunnelStatus {
  running: boolean;
  pid?: number;
  configured: boolean;
  lastError?: string;
}

export class TunnelSupervisor {
  #child?: ChildProcessWithoutNullStreams;
  #lastError?: string;

  status(config: RuntimeConfig): TunnelStatus {
    return {
      running: Boolean(this.#child && this.#child.exitCode === null),
      pid: this.#child?.pid,
      configured: Boolean(config.tunnelId && config.tunnelApiKey),
      lastError: this.#lastError,
    };
  }

  async start(config: RuntimeConfig, mcpUrl: string): Promise<TunnelStatus> {
    if (this.#child && this.#child.exitCode === null) return this.status(config);
    if (!config.tunnelId || !config.tunnelApiKey) {
      throw new Error(
        "Secure MCP Tunnel credentials are missing. Set CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY.",
      );
    }

    this.#lastError = undefined;
    const child = spawn(
      config.tunnelClientBin,
      ["run", "--mcp-server-url", mcpUrl, "--log.level=info"],
      {
        env: {
          ...process.env,
          CONTROL_PLANE_TUNNEL_ID: config.tunnelId,
          CONTROL_PLANE_API_KEY: config.tunnelApiKey,
          MCP_SERVER_URL: mcpUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#child = child;

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });
    child.once("error", error => {
      this.#lastError = error.message;
    });
    child.once("exit", code => {
      if (code && code !== 0) {
        this.#lastError = stderr.trim() || "tunnel-client exited with code " + code;
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (child.exitCode !== null) {
          reject(new Error(this.#lastError || "tunnel-client exited before becoming ready"));
          return;
        }
        resolve();
      }, 750);
      child.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", code => {
        clearTimeout(timer);
        if (code !== null) reject(new Error(this.#lastError || "tunnel-client exited with code " + code));
      });
    });

    return this.status(config);
  }

  async stop(config: RuntimeConfig): Promise<TunnelStatus> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      this.#child = undefined;
      return this.status(config);
    }

    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#child = undefined;
    return this.status(config);
  }
}
