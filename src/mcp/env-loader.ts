import { existsSync, readFileSync } from "node:fs";

let loaded = false;

/**
 * Loads local .env values without adding a runtime dependency.
 * Existing process environment variables always win.
 */
export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  const path = ".env";
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index < 0) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
