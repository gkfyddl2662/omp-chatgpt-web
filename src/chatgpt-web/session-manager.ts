import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface BrowserSessionState {
  profileDir: string;
  createdAt: string;
  backend: "chatgpt-web";
}

function defaultStatePath(): string {
  return path.join(os.homedir(), ".omp-chatgpt-web", "session.json");
}

export class BrowserSessionManager {
  readonly statePath: string;

  constructor(statePath = defaultStatePath()) {
    this.statePath = statePath;
  }

  async save(profileDir: string): Promise<BrowserSessionState> {
    const state: BrowserSessionState = {
      profileDir,
      createdAt: new Date().toISOString(),
      backend: "chatgpt-web",
    };

    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  async load(): Promise<BrowserSessionState | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8")) as BrowserSessionState;
    } catch {
      return undefined;
    }
  }

  async doctor(): Promise<{
    sessionFile: string;
    session: BrowserSessionState | undefined;
  }> {
    return {
      sessionFile: this.statePath,
      session: await this.load(),
    };
  }
}
