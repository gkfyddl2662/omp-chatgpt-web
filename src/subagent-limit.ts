import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_WEB_SUBAGENT_LIMIT = 4;
export const UNLIMITED_WEB_SUBAGENTS = -1;

export function normalizeWebSubagentLimit(
  value: unknown,
  fallback = DEFAULT_WEB_SUBAGENT_LIMIT,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < UNLIMITED_WEB_SUBAGENTS) return fallback;
  return parsed;
}

interface RootBudget {
  used: number;
  owners: number;
}

export interface SubagentLimitStatus {
  used: number;
  limit: number;
  remaining: number | null;
  unlimited: boolean;
}

export interface SubagentSpawnDecision extends SubagentLimitStatus {
  allowed: boolean;
}

export class WebSubagentLimiter {
  readonly #budgets = new Map<string, RootBudget>();

  #budget(rootKey: string): RootBudget {
    let budget = this.#budgets.get(rootKey);
    if (!budget) {
      budget = { used: 0, owners: 0 };
      this.#budgets.set(rootKey, budget);
    }
    return budget;
  }

  retain(rootKey: string): void {
    this.#budget(rootKey).owners += 1;
  }

  release(rootKey: string): void {
    const budget = this.#budgets.get(rootKey);
    if (!budget) return;
    budget.owners = Math.max(0, budget.owners - 1);
    if (budget.owners === 0) this.#budgets.delete(rootKey);
  }

  trySpawn(rootKey: string, _spawnKey: string | undefined, limit: number): SubagentSpawnDecision {
    const normalizedLimit = normalizeWebSubagentLimit(limit);
    const budget = this.#budget(rootKey);

    // OMP now fires before_subagent_spawn exactly once per actual child
    // dispatch. A repeated spawnKey therefore represents another real spawn
    // (for example a model reusing the same task label), not a hook replay.
    // Count every dispatch so a cumulative hard limit cannot be bypassed by
    // repeatedly spawning the same named subagent.
    if (normalizedLimit >= 0 && budget.used >= normalizedLimit) {
      return {
        allowed: false,
        ...this.#statusFromBudget(budget, normalizedLimit),
      };
    }

    budget.used += 1;

    return {
      allowed: true,
      ...this.#statusFromBudget(budget, normalizedLimit),
    };
  }

  status(rootKey: string, limit: number): SubagentLimitStatus {
    return this.#statusFromBudget(this.#budget(rootKey), normalizeWebSubagentLimit(limit));
  }

  clearAll(): void {
    this.#budgets.clear();
  }

  #statusFromBudget(budget: RootBudget, limit: number): SubagentLimitStatus {
    const unlimited = limit < 0;
    return {
      used: budget.used,
      limit,
      remaining: unlimited ? null : Math.max(0, limit - budget.used),
      unlimited,
    };
  }
}

function parentSessionFromFile(sessionFile: string): string | undefined {
  try {
    const firstLine = readFileSync(sessionFile, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine) as { parentSession?: unknown };
    return typeof header.parentSession === "string" && header.parentSession.trim()
      ? header.parentSession
      : undefined;
  } catch {
    return undefined;
  }
}

export interface SessionLineageSnapshot {
  sessionId: string;
  sessionFile?: string;
  parentSession?: string;
}

export function resolveSubagentRootKey(snapshot: SessionLineageSnapshot): string {
  if (!snapshot.sessionFile) return "memory:shared-web-runtime";

  let current = resolve(snapshot.sessionFile);
  let parent = snapshot.parentSession ? resolve(snapshot.parentSession) : undefined;
  const seen = new Set<string>();

  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current)) break;
    seen.add(current);

    if (parent) {
      current = parent;
      parent = parentSessionFromFile(current);
      continue;
    }

    const structuralParent = resolve(dirname(current) + ".jsonl");
    if (structuralParent !== current && existsSync(structuralParent)) {
      current = structuralParent;
      parent = parentSessionFromFile(current);
      continue;
    }
    break;
  }

  return "file:" + current;
}
