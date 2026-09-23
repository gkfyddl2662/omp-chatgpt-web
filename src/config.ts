import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface RuntimeConfig {
  mcpHost: string;
  mcpPort: number;
  connectorName: string;
  chatUrl: string;
  browserProfileDir: string;
  browserExecutable?: string;
  headed: boolean;
  autoApproveToolCalls: boolean;
  turnTimeoutMs: number;
  tunnelClientBin: string;
  tunnelId?: string;
  tunnelApiKey?: string;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find(path => existsSync(path));
}

export function defaultBrowserExecutable(): string | undefined {
  const explicit = process.env.OMP_CHATGPT_WEB_BROWSER;
  if (explicit) return explicit;

  if (platform() === "darwin") {
    return firstExisting([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]);
  }

  if (platform() === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((value): value is string => Boolean(value));
    return firstExisting(roots.flatMap(root => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]));
  }

  return firstExisting([
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/brave-browser",
  ]);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const port = Math.floor(envNumber("OMP_CHATGPT_WEB_MCP_PORT", 8791));
  if (port < 1 || port > 65535) {
    throw new Error("OMP_CHATGPT_WEB_MCP_PORT is invalid: " + port);
  }

  return {
    mcpHost: "127.0.0.1",
    mcpPort: port,
    connectorName: process.env.OMP_CHATGPT_WEB_CONNECTOR?.trim() || "OMP Local",
    chatUrl: process.env.OMP_CHATGPT_WEB_URL?.trim() || "https://chatgpt.com/?temporary-chat=true",
    browserProfileDir:
      process.env.OMP_CHATGPT_WEB_PROFILE?.trim() || join(homedir(), ".omp", "chatgpt-web", "chrome"),
    browserExecutable: defaultBrowserExecutable(),
    headed: envBoolean("OMP_CHATGPT_WEB_HEADED", true),
    autoApproveToolCalls: envBoolean("OMP_CHATGPT_WEB_AUTO_APPROVE", false),
    turnTimeoutMs: Math.floor(envNumber("OMP_CHATGPT_WEB_TURN_TIMEOUT_MS", 15 * 60_000)),
    tunnelClientBin: process.env.TUNNEL_CLIENT_BIN?.trim() || "tunnel-client",
    tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID?.trim() || undefined,
    tunnelApiKey: process.env.CONTROL_PLANE_API_KEY?.trim() || undefined,
  };
}

export function mcpServerUrl(config: RuntimeConfig): string {
  return "http://" + config.mcpHost + ":" + config.mcpPort + "/mcp";
}

export function tunnelConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.tunnelId && config.tunnelApiKey);
}
