import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
} from "@oh-my-pi/pi-ai";
import type { RuntimeConfig } from "./config.js";
import {
  compileCompactionPrompt,
  compileRetainedCompactionPrompt,
  isOmpCompactionContext,
} from "./compaction.js";
import type { ChatGptBrowserBackend } from "./browser-backend.js";
import {
  compileBrowserContinuationPrompt,
  compileBrowserPrompt,
} from "./prompt.js";
import type { TurnBroker } from "./turn-broker.js";

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseMessage(model: Model, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function pushToolCall(
  stream: AssistantMessageEventStream,
  model: Model,
  action: { toolCallId: string; name: string; arguments: Record<string, unknown> },
): void {
  const start = baseMessage(model, "toolUse");
  stream.push({ type: "start", partial: start });

  const toolCall: ToolCall = {
    type: "toolCall",
    id: action.toolCallId,
    name: action.name,
    arguments: action.arguments,
  };
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: start });

  const message: AssistantMessage = {
    ...start,
    content: [toolCall],
    stopReason: "toolUse",
  };
  stream.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  stream.push({ type: "done", reason: "toolUse", message });
}

function pushText(stream: AssistantMessageEventStream, model: Model, text: string): void {
  const start = baseMessage(model, "stop");
  stream.push({ type: "start", partial: start });
  stream.push({ type: "text_start", contentIndex: 0, partial: start });

  const message: AssistantMessage = {
    ...start,
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: message,
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: message,
  });
  stream.push({ type: "done", reason: "stop", message });
}

function pushError(stream: AssistantMessageEventStream, model: Model, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const assistant: AssistantMessage = {
    ...baseMessage(model, "error"),
    errorMessage: message,
  };
  stream.push({ type: "error", reason: "error", error: assistant });
}

function sessionKey(options?: SimpleStreamOptions): string {
  return (
    options?.promptCacheKey?.trim() ||
    options?.sessionId?.trim() ||
    "ephemeral_" + randomUUID().replace(/-/g, "")
  );
}

function newestMatchingToolResult(
  context: Context,
  expectedToolCallId: string | undefined,
): ToolResultMessage | undefined {
  if (!expectedToolCallId) return undefined;
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "toolResult" && message.toolCallId === expectedToolCallId) {
      return message;
    }
  }
  return undefined;
}

export interface WebModelProviderDependencies {
  config: RuntimeConfig;
  broker: TurnBroker;
  browser: ChatGptBrowserBackend;
  ensureTransport(): Promise<void>;
}

export class WebModelProvider {
  readonly #config: RuntimeConfig;
  readonly #broker: TurnBroker;
  readonly #browser: ChatGptBrowserBackend;
  readonly #ensureTransport: () => Promise<void>;

  constructor(deps: WebModelProviderDependencies) {
    this.#config = deps.config;
    this.#broker = deps.broker;
    this.#browser = deps.browser;
    this.#ensureTransport = deps.ensureTransport;
  }

  streamSimple = (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void this.#run(stream, model, context, options);
    return stream;
  };

  async #run(
    stream: AssistantMessageEventStream,
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<void> {
    const key = sessionKey(options);
    const signal = options?.signal;

    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Provider request aborted", "AbortError");

      if (isOmpCompactionContext(context, options)) {
        try {
          let summary: string;
          const activeTurn = this.#broker.hasActive(key) || this.#browser.isTurnActive(key);

          if (this.#browser.hasRetainedConversation(key) && !activeTurn) {
            summary = await this.#browser.compactRetainedSession(
              key,
              compileRetainedCompactionPrompt(context),
              this.#config,
              signal,
            );
          } else {
            summary = await this.#browser.runTextOnly(
              compileCompactionPrompt(context),
              this.#config,
              signal,
            );

            if (this.#browser.hasSession(key)) {
              if (activeTurn) {
                await this.#browser.markResetAfterTurn(key);
              } else {
                await this.#browser.resetSession(key, this.#config);
              }
            }
          }

          pushText(stream, model, summary);
        } catch (error) {
          pushError(stream, model, error);
        }
        return;
      }

      const expectedToolCallId = this.#broker.pendingToolCallId(key);
      const toolResult = newestMatchingToolResult(context, expectedToolCallId);
      if (toolResult) {
        this.#broker.settleToolResult(key, toolResult);
      }

      if (!this.#broker.hasActive(key)) {
        await this.#ensureTransport();
        const turn = this.#broker.begin(key, context.tools ?? []);
        const prompt = this.#browser.hasRetainedConversation(key)
          ? compileBrowserContinuationPrompt(context, turn.token)
          : compileBrowserPrompt(context, turn.token);
        try {
          await this.#browser.startTurn(key, prompt, this.#config);
        } catch (error) {
          this.#broker.end(key);
          throw error;
        }
      } else {
        this.#broker.updateTools(key, context.tools ?? []);
      }

      const timeoutSignal = AbortSignal.timeout(this.#config.turnTimeoutMs);
      const actionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const action = await this.#broker.nextAction(key, actionSignal);
      if (action.type === "tool") {
        pushToolCall(stream, model, action);
        return;
      }

      await this.#browser.finishTurn(key, this.#config, signal);
      pushText(stream, model, action.answer);
      this.#broker.end(key);
    } catch (error) {
      this.#broker.end(key);
      await this.#browser.invalidateSession(key).catch(() => undefined);
      pushError(stream, model, error);
    }
  }
}
