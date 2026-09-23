import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "./config.js";

export interface TunnelStatus {
  running: boolean;
  ready: boolean;
  pid?: number;
  configured: boolean;
  healthUrl?: string;
  lastError?: string;
}

export interface TunnelDiagnostics extends TunnelStatus {
  readyz?: { status: number; body: string };
  health?: unknown;
  mcpHealth?: unknown;
  recentLogs?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TunnelSupervisor {
  #child?: ChildProcess;
  #lastError?: string;
  #ready = false;
  #healthDir?: string;
  #healthUrlFile?: string;
  #healthBaseUrl?: string;
  #recentLogs = "";

  status(config: RuntimeConfig): TunnelStatus {
    return {
      running: Boolean(this.#child && this.#child.exitCode === null),
      ready: this.#ready,
      pid: this.#child?.pid,
      configured: Boolean(config.tunnelId && config.tunnelApiKey),
      healthUrl: this.#healthBaseUrl,
      lastError: this.#lastError,
    };
  }

  async diagnostics(config: RuntimeConfig): Promise<TunnelDiagnostics> {
    const base = this.status(config);
    const relevantLogs = this.#recentLogs
      .split(/\r?\n/)
      .filter(line =>
        /mcpclient|dispatcher|controlplane|server\/discover|tools\/list|tools\/call|rpc_method|status_code|429|404|WARN|ERROR|ready|response/i.test(line)
      )
      .slice(-80)
      .join("\n")
      .trim();

    const result: TunnelDiagnostics = {
      ...base,
      recentLogs: relevantLogs || undefined,
    };
    if (!this.#healthBaseUrl) return result;

    try {
      const ready = await fetch(this.#healthBaseUrl + "/readyz", {
        signal: AbortSignal.timeout(2_000),
      });
      result.readyz = {
        status: ready.status,
        body: (await ready.text()).trim(),
      };
    } catch (error) {
      result.readyz = {
        status: 0,
        body: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const mcpHealth = await fetch(this.#healthBaseUrl + "/health/mcp", {
        signal: AbortSignal.timeout(2_000),
      });
      const text = await mcpHealth.text();
      try {
        result.mcpHealth = JSON.parse(text);
      } catch {
        result.mcpHealth = { status: mcpHealth.status, body: text.trim() };
      }
    } catch (error) {
      result.mcpHealth = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const health = await fetch(this.#healthBaseUrl + "/health?details=true", {
        signal: AbortSignal.timeout(2_000),
      });
      const text = await health.text();
      if (health.status !== 404) {
        try {
          result.health = JSON.parse(text);
        } catch {
          result.health = { status: health.status, body: text.trim() };
        }
      } else {
        result.health = {
          status: 404,
          note:
            "Detailed /health endpoint is unavailable in this tunnel-client build; " +
            "/readyz remains the readiness source of truth.",
        };
      }
    } catch (error) {
      result.health = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return result;
  }

  async start(config: RuntimeConfig, mcpUrl: string): Promise<TunnelStatus> {
    if (this.#child && this.#child.exitCode === null) {
      if (!this.#ready) await this.#waitUntilReady();
      return this.status(config);
    }
    if (!config.tunnelId || !config.tunnelApiKey) {
      throw new Error(
        "Secure MCP Tunnel credentials are missing. Use /web-config tunnel <id> and /web-config api <key>.",
      );
    }

    this.#lastError = undefined;
    this.#ready = false;
    this.#recentLogs = "";
    this.#healthBaseUrl = undefined;
    this.#healthDir = await mkdtemp(join(tmpdir(), "omp-chatgpt-web-tunnel-"));
    this.#healthUrlFile = join(this.#healthDir, "health.url");

    const child = spawn(
      config.tunnelClientBin,
      [
        "run",
        "--mcp.server-url",
        mcpUrl,
        "--health.listen-addr",
        "127.0.0.1:0",
        "--health.url-file",
        this.#healthUrlFile,
        "--log.level=info",
      ],
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

    const appendLog = (source: string, chunk: unknown) => {
      this.#recentLogs += "[" + source + "] " + String(chunk);
      if (this.#recentLogs.length > 32_768) {
        this.#recentLogs = this.#recentLogs.slice(-32_768);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => appendLog("stdout", chunk));
    child.stderr?.on("data", chunk => appendLog("stderr", chunk));

    child.once("error", error => {
      this.#lastError = error.message;
      this.#ready = false;
    });
    child.once("exit", code => {
      this.#ready = false;
      if (code && code !== 0) {
        this.#lastError =
          this.#recentLogs.trim() ||
          "tunnel-client exited with code " + code;
      }
    });

    try {
      await this.#waitUntilReady();
    } catch (error) {
      const detail = await this.diagnostics(config).catch(() => undefined);
      const suffix = detail
        ? "\nDiagnostics: " + JSON.stringify(detail, null, 2)
        : "";
      this.#lastError =
        (error instanceof Error ? error.message : String(error)) + suffix;
      await this.stop(config);
      throw new Error(this.#lastError);
    }

    return this.status(config);
  }

  async #waitUntilReady(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      throw new Error(this.#lastError || "tunnel-client is not running");
    }

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (this.#lastError) {
        throw new Error(this.#lastError);
      }
      if (child.exitCode !== null) {
        throw new Error(
          "tunnel-client exited before becoming ready",
        );
      }

      if (!this.#healthBaseUrl && this.#healthUrlFile) {
        try {
          const value = (await readFile(this.#healthUrlFile, "utf8")).trim();
          const normalized = value.replace(/\/+$/, "");
          if (/^https?:\/\/127\.0\.0\.1:\d+$/.test(normalized)) {
            this.#healthBaseUrl = normalized;
          }
        } catch {
          // URL file is created asynchronously by tunnel-client.
        }
      }

      if (this.#healthBaseUrl) {
        try {
          const response = await fetch(this.#healthBaseUrl + "/readyz", {
            signal: AbortSignal.timeout(1_500),
          });
          if (response.ok) {
            this.#ready = true;
            return;
          }
        } catch {
          // Keep waiting until the readiness deadline.
        }
      }

      await sleep(250);
    }

    throw new Error(
      "tunnel-client did not become ready within 20 seconds. " +
        "Use /web-tunnel status for component diagnostics.",
    );
  }

  async stop(config: RuntimeConfig): Promise<TunnelStatus> {
    const child = this.#child;
    if (child && child.exitCode === null) {
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
    }

    this.#child = undefined;
    this.#ready = false;

    const healthDir = this.#healthDir;
    this.#healthDir = undefined;
    this.#healthUrlFile = undefined;
    this.#healthBaseUrl = undefined;
    if (healthDir) {
      await rm(healthDir, { recursive: true, force: true }).catch(() => undefined);
    }

    return this.status(config);
  }
}
