import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface PersistedRuntimeConfig {
  connectorName?: string;
  browserExecutable?: string;
  browserCdpPort?: number;
  tunnelId?: string;
  tunnelApiKey?: string;
}

export interface RuntimeConfig {
  mcpHost: string;
  mcpPort: number;
  connectorName: string;
  chatUrl: string;
  browserProfileDir: string;
  browserExecutable?: string;
  browserCdpPort: number;
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

export function persistentConfigPath(): string {
  return join(homedir(), ".omp", "chatgpt-web", "config.json");
}

function readPersistentConfig(): PersistedRuntimeConfig {
  const path = persistentConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PersistedRuntimeConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function savePersistentConfig(patch: PersistedRuntimeConfig): PersistedRuntimeConfig {
  const path = persistentConfigPath();
  const current = readPersistentConfig();
  const next: PersistedRuntimeConfig = { ...current };

  for (const [key, value] of Object.entries(patch) as Array<
    [keyof PersistedRuntimeConfig, PersistedRuntimeConfig[keyof PersistedRuntimeConfig]]
  >) {
    if (value === undefined || value === null || value === "") {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }

  mkdirSync(join(homedir(), ".omp", "chatgpt-web"), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACL semantics differ from POSIX mode bits.
  }
  return next;
}

export function applyRuntimeConfigPatch(
  config: RuntimeConfig,
  patch: PersistedRuntimeConfig,
): PersistedRuntimeConfig {
  const saved = savePersistentConfig(patch);
  if (patch.connectorName !== undefined) config.connectorName = patch.connectorName || "OMP Local";
  if (patch.browserExecutable !== undefined) config.browserExecutable = patch.browserExecutable || undefined;
  if (patch.browserCdpPort !== undefined && Number.isFinite(patch.browserCdpPort)) {
    config.browserCdpPort = Math.floor(patch.browserCdpPort);
  }
  if (patch.tunnelId !== undefined) config.tunnelId = patch.tunnelId || undefined;
  if (patch.tunnelApiKey !== undefined) config.tunnelApiKey = patch.tunnelApiKey || undefined;
  return saved;
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
  const persisted = readPersistentConfig();
  const port = Math.floor(envNumber("OMP_CHATGPT_WEB_MCP_PORT", 8791));
  if (port < 1 || port > 65535) {
    throw new Error("OMP_CHATGPT_WEB_MCP_PORT is invalid: " + port);
  }

  return {
    mcpHost: "127.0.0.1",
    mcpPort: port,
    connectorName: persisted.connectorName || process.env.OMP_CHATGPT_WEB_CONNECTOR?.trim() || "OMP Local",
    chatUrl: process.env.OMP_CHATGPT_WEB_URL?.trim() || "https://chatgpt.com/?temporary-chat=true",
    browserProfileDir:
      process.env.OMP_CHATGPT_WEB_PROFILE?.trim() || join(homedir(), ".omp", "chatgpt-web", "chrome"),
    browserExecutable: persisted.browserExecutable || process.env.OMP_CHATGPT_WEB_BROWSER?.trim() || defaultBrowserExecutable(),
    browserCdpPort: Math.floor(
      persisted.browserCdpPort ?? envNumber("OMP_CHATGPT_WEB_CDP_PORT", 9222),
    ),
    headed: envBoolean("OMP_CHATGPT_WEB_HEADED", true),
    autoApproveToolCalls: envBoolean("OMP_CHATGPT_WEB_AUTO_APPROVE", false),
    turnTimeoutMs: Math.floor(envNumber("OMP_CHATGPT_WEB_TURN_TIMEOUT_MS", 15 * 60_000)),
    tunnelClientBin: process.env.TUNNEL_CLIENT_BIN?.trim() || "tunnel-client",
    tunnelId: persisted.tunnelId || process.env.CONTROL_PLANE_TUNNEL_ID?.trim() || undefined,
    tunnelApiKey: persisted.tunnelApiKey || process.env.CONTROL_PLANE_API_KEY?.trim() || undefined,
  };
}

export function mcpServerUrl(config: RuntimeConfig): string {
  return "http://" + config.mcpHost + ":" + config.mcpPort + "/mcp";
}

export function tunnelConfigured(config: RuntimeConfig): boolean {
  return Boolean(config.tunnelId && config.tunnelApiKey);
}
