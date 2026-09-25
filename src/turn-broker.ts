import { randomUUID } from "node:crypto";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";

export interface BrowserToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface BrowserToolInventoryPage {
  tools: BrowserToolDescriptor[];
  total: number;
  next_offset: number | null;
}

export interface BrowserToolReceipt {
  tool_call_id: string;
  tool: string;
  is_error: boolean;
  content: Array<Record<string, unknown>>;
}

export type BrokerAction =
  | {
      type: "tool";
      token: string;
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "complete";
      token: string;
      answer: string;
    };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PendingTool {
  toolCallId: string;
  name: string;
  result: Deferred<BrowserToolReceipt>;
  timer: ReturnType<typeof setTimeout>;
}

interface TurnState {
  sessionKey: string;
  token: string;
  tools: Map<string, Tool>;
  actions: BrokerAction[];
  waiters: Array<Deferred<BrokerAction>>;
  pendingTool?: PendingTool;
  closed: boolean;
  completed: boolean;
  retireTimer?: ReturnType<typeof setTimeout>;
}

export interface BeginTurnResult {
  token: string;
  reused: boolean;
}

export type ToolSchemaProjector = (
  tool: Tool,
) => Record<string, unknown>;

function inventorySearchTerms(query: string | undefined): {
  phrase: string;
  tokens: string[];
} {
  const phrase = (query ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const tokens = [...new Set(phrase.split(" ").filter(Boolean))];
  return { phrase, tokens };
}

function inventoryMatches(
  tools: readonly Tool[],
  query: string | undefined,
): Tool[] {
  const { phrase, tokens } = inventorySearchTerms(query);
  if (!phrase) return [...tools];

  const searchable = tools.map(tool => ({
    tool,
    haystack: (tool.name + "\n" + tool.description).toLowerCase().replace(/\s+/g, " "),
  }));

  // Prefer the user's literal phrase when it exists. If a model writes
  // "read file", this still keeps exact phrase search precise.
  const phraseMatches = searchable
    .filter(item => item.haystack.includes(phrase))
    .map(item => item.tool);
  if (phraseMatches.length > 0 || tokens.length <= 1) return phraseMatches;

  // Natural-language inventory probes often contain several independent
  // keywords (for example "write read"). First interpret those as an AND
  // query across name + description.
  const allTokenMatches = searchable
    .filter(item => tokens.every(token => item.haystack.includes(token)))
    .map(item => item.tool);
  if (allTokenMatches.length > 0) return allTokenMatches;

  // If no single tool contains every token, interpret the query as a request
  // for tools matching any of the terms. This makes "write read" discover
  // separate write and read tools instead of returning an empty inventory.
  return searchable
    .filter(item => tokens.some(token => item.haystack.includes(token)))
    .map(item => item.tool);
}

function defaultToolSchemaProjector(tool: Tool): Record<string, unknown> {
  const parameters = tool.parameters as unknown;
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }

  if (typeof parameters === "function") {
    const toJsonSchema = Reflect.get(parameters, "toJsonSchema");
    if (typeof toJsonSchema === "function") {
      const schema = Reflect.apply(toJsonSchema, parameters, []);
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        return schema as Record<string, unknown>;
      }
    }
  }

  return {};
}

export class TurnBroker {
  readonly #bySession = new Map<string, TurnState>();
  readonly #byToken = new Map<string, TurnState>();
  readonly #toolTimeoutMs: number;
  readonly #completedTokenGraceMs: number;
  readonly #schemaForTool: ToolSchemaProjector;

  constructor(options?: {
    toolTimeoutMs?: number;
    completedTokenGraceMs?: number;
    schemaForTool?: ToolSchemaProjector;
  }) {
    this.#toolTimeoutMs = options?.toolTimeoutMs ?? 85_000;
    this.#completedTokenGraceMs = options?.completedTokenGraceMs ?? 180_000;
    this.#schemaForTool =
      options?.schemaForTool ?? defaultToolSchemaProjector;
  }

  begin(sessionKey: string, tools: readonly Tool[]): BeginTurnResult {
    const existing = this.#bySession.get(sessionKey);
    if (existing && !existing.closed) {
      return { token: existing.token, reused: true };
    }

    const token = "turn_" + randomUUID().replace(/-/g, "");
    const state: TurnState = {
      sessionKey,
      token,
      tools: new Map(tools.map(tool => [tool.name, tool])),
      actions: [],
      waiters: [],
      closed: false,
      completed: false,
    };
    this.#bySession.set(sessionKey, state);
    this.#byToken.set(token, state);
    return { token, reused: false };
  }

  hasActive(sessionKey: string): boolean {
    const state = this.#bySession.get(sessionKey);
    return Boolean(state && !state.closed);
  }

  tokenForSession(sessionKey: string): string | undefined {
    const state = this.#bySession.get(sessionKey);
    return state && !state.closed ? state.token : undefined;
  }

  updateTools(sessionKey: string, tools: readonly Tool[]): void {
    const state = this.#requireSession(sessionKey);
    state.tools = new Map(tools.map(tool => [tool.name, tool]));
  }

  inventory(
    token: string,
    options?: { query?: string; offset?: number; limit?: number; includeSchema?: boolean },
  ): BrowserToolInventoryPage {
    const state = this.#requireToken(token);
    if (state.completed) {
      return { tools: [], total: 0, next_offset: null };
    }
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const limit = Math.min(50, Math.max(1, Math.floor(options?.limit ?? 20)));
    const includeSchema = options?.includeSchema !== false;

    const matches = inventoryMatches(
      [...state.tools.values()],
      options?.query,
    );
    const page = matches.slice(offset, offset + limit).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: includeSchema ? this.#schemaForTool(tool) : {},
    }));
    return {
      tools: page,
      total: matches.length,
      next_offset: offset + page.length < matches.length ? offset + page.length : null,
    };
  }

  async requestTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrowserToolReceipt> {
    const state = this.#requireToken(token);
    if (state.completed) {
      throw new Error(
        "OMP Web turn is already completed. Do not call more tools; render the final answer.",
      );
    }
    if (!state.tools.has(name)) {
      throw new Error("OMP tool is not available in this turn: " + name);
    }
    if (state.pendingTool) {
      throw new Error(
        "Another OMP tool call is still in flight. Wait for its result before calling the next tool.",
      );
    }

    const toolCallId = "web_" + randomUUID().replace(/-/g, "");
    const result = deferred<BrowserToolReceipt>();
    const timer = setTimeout(() => {
      if (state.pendingTool?.toolCallId !== toolCallId) return;
      state.pendingTool = undefined;
      result.reject(
        new Error(
          "OMP tool " + name + " did not return before the ChatGPT MCP transport deadline.",
        ),
      );
    }, this.#toolTimeoutMs);
    timer.unref?.();
    state.pendingTool = { toolCallId, name, result, timer };

    const action: BrokerAction = {
      type: "tool",
      token,
      toolCallId,
      name,
      arguments: args,
    };
    this.#enqueue(state, action);

    if (signal) {
      const abort = () => {
        if (state.pendingTool?.toolCallId !== toolCallId) return;
        clearTimeout(timer);
        state.pendingTool = undefined;
        result.reject(signal.reason ?? new DOMException("MCP tool request aborted", "AbortError"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    return result.promise;
  }

  complete(token: string, answer: string): void {
    const state = this.#requireToken(token);
    if (state.completed) return;
    if (state.pendingTool) {
      throw new Error("Cannot complete the Web turn while an OMP tool call is still in flight.");
    }
    const text = answer.trim();
    if (!text) throw new Error("omp_turn_complete requires a non-empty answer.");
    state.completed = true;
    this.#enqueue(state, { type: "complete", token, answer: text });
  }

  nextAction(sessionKey: string, signal?: AbortSignal): Promise<BrokerAction> {
    const state = this.#requireSession(sessionKey);
    const action = state.actions.shift();
    if (action) return Promise.resolve(action);

    const waiter = deferred<BrokerAction>();
    state.waiters.push(waiter);
    if (signal) {
      const abort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        waiter.reject(signal.reason ?? new DOMException("Provider turn aborted", "AbortError"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    return waiter.promise;
  }

  settleToolResult(sessionKey: string, message: ToolResultMessage): boolean {
    const state = this.#bySession.get(sessionKey);
    const pending = state?.pendingTool;
    if (!state || state.closed || !pending || pending.toolCallId !== message.toolCallId) {
      return false;
    }

    clearTimeout(pending.timer);
    state.pendingTool = undefined;
    pending.result.resolve({
      tool_call_id: message.toolCallId,
      tool: message.toolName,
      is_error: message.isError,
      content: message.content.map(block => {
        if (block.type === "text") return { type: "text", text: block.text };
        return {
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        };
      }),
    });
    return true;
  }

  pendingToolCallId(sessionKey: string): string | undefined {
    return this.#bySession.get(sessionKey)?.pendingTool?.toolCallId;
  }

  end(sessionKey: string): void {
    const state = this.#bySession.get(sessionKey);
    if (!state || state.closed) return;
    state.closed = true;
    if (state.pendingTool) {
      clearTimeout(state.pendingTool.timer);
      state.pendingTool.result.reject(new Error("OMP Web turn ended before the tool result was returned."));
      state.pendingTool = undefined;
    }
    for (const waiter of state.waiters.splice(0)) {
      waiter.reject(new Error("OMP Web turn ended."));
    }
    this.#bySession.delete(sessionKey);

    if (!state.completed || this.#completedTokenGraceMs <= 0) {
      this.#byToken.delete(state.token);
      return;
    }

    // ChatGPT may still be rendering the final assistant prose after
    // omp_turn_complete has already returned the logical answer to OMP. Keep a
    // completed, tool-disabled token tombstone briefly so late browser MCP
    // traffic receives an explicit completed-turn response instead of a noisy
    // "expired token" error. New OMP turns are unaffected because the session
    // mapping is removed immediately and receive a fresh token.
    state.retireTimer = setTimeout(() => {
      if (this.#byToken.get(state.token) === state) {
        this.#byToken.delete(state.token);
      }
    }, this.#completedTokenGraceMs);
    state.retireTimer.unref?.();
  }

  abortAll(reason: unknown = new Error("OMP ChatGPT Web runtime stopped.")): void {
    for (const state of new Set([
      ...this.#bySession.values(),
      ...this.#byToken.values(),
    ])) {
      if (state.retireTimer) {
        clearTimeout(state.retireTimer);
        state.retireTimer = undefined;
      }
      if (state.pendingTool) {
        clearTimeout(state.pendingTool.timer);
        state.pendingTool.result.reject(reason);
        state.pendingTool = undefined;
      }
      for (const waiter of state.waiters.splice(0)) waiter.reject(reason);
      state.closed = true;
    }
    this.#bySession.clear();
    this.#byToken.clear();
  }

  #enqueue(state: TurnState, action: BrokerAction): void {
    const waiter = state.waiters.shift();
    if (waiter) waiter.resolve(action);
    else state.actions.push(action);
  }

  #requireSession(sessionKey: string): TurnState {
    const state = this.#bySession.get(sessionKey);
    if (!state || state.closed) throw new Error("No active ChatGPT Web turn for OMP session: " + sessionKey);
    return state;
  }

  #requireToken(token: string): TurnState {
    const state = this.#byToken.get(token);
    if (!state || (state.closed && !state.completed)) {
      throw new Error("Unknown or expired OMP Web turn token.");
    }
    return state;
  }
}
