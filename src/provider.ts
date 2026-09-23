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

const OMP_TITLE_SYSTEM_MARKER =
  "Write a ~5 word title using only the task described in the next user message.";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      return Reflect.get(part, "type") === "text"
        ? String(Reflect.get(part, "text") ?? "")
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isOmpTitleContext(context: Context): boolean {
  return (context.systemPrompt ?? []).some(prompt =>
    prompt.includes(OMP_TITLE_SYSTEM_MARKER)
  );
}

function localOmpTitle(context: Context): string {
  const source = context.messages
    .filter(message => message.role === "user")
    .map(message => messageText(message.content))
    .join(" ")
    .replace(/<\/?user>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!source) return "<title/>";

  const title = source
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .replace(/[.!?。！？]+$/g, "")
    .slice(0, 96)
    .trim();

  return title ? "<title>" + title + "</title>" : "<title/>";
}

function requestKey(options?: SimpleStreamOptions): string {
  return (
    options?.sessionId?.trim() ||
    options?.promptCacheKey?.trim() ||
    "request_" + randomUUID().replace(/-/g, "")
  );
}

function conversationKey(
  options: SimpleStreamOptions | undefined,
  fallback: string,
): string {
  return (
    options?.promptCacheKey?.trim() ||
    options?.sessionId?.trim() ||
    fallback
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
    const request = requestKey(options);
    const conversation = conversationKey(options, request);
    const signal = options?.signal;

    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Provider request aborted", "AbortError");

      // OMP title generation is a background UI utility request, not an agent
      // model turn. Never let it acquire the retained ChatGPT conversation or
      // attach OMP Local; doing so can race the real foreground turn.
      if (isOmpTitleContext(context)) {
        pushText(stream, model, localOmpTitle(context));
        return;
      }

      if (isOmpCompactionContext(context, options)) {
        try {
          let summary: string;

          if (this.#browser.hasSession(conversation)) {
            // Never open a second compaction tab while the retained ChatGPT
            // conversation is still active. Reserve this conversation epoch,
            // let the foreground turn finish, compact the same thread, then
            // reset that same tab before allowing another ordinary turn.
            if (
              this.#browser.hasRetainedConversation(conversation) ||
              this.#browser.isTurnActive(conversation)
            ) {
              summary = await this.#browser.compactRetainedSessionWhenIdle(
                conversation,
                compileRetainedCompactionPrompt(context),
                this.#config,
                signal,
              );
            } else {
              // The retained session disappeared while we were waiting (for
              // example, browser closure or a failed turn). Only then fall back
              // to a standalone text-only compaction request.
              summary = await this.#browser.runTextOnly(
                compileCompactionPrompt(context),
                this.#config,
                signal,
              );
            }
          } else {
            summary = await this.#browser.runTextOnly(
              compileCompactionPrompt(context),
              this.#config,
              signal,
            );
          }

          pushText(stream, model, summary);
        } catch (error) {
          pushError(stream, model, error);
        }
        return;
      }

      const expectedToolCallId = this.#broker.pendingToolCallId(request);
      const toolResult = newestMatchingToolResult(context, expectedToolCallId);
      if (toolResult) {
        this.#broker.settleToolResult(request, toolResult);
      }

      if (!this.#broker.hasActive(request)) {
        await this.#ensureTransport();
        const turn = this.#broker.begin(request, context.tools ?? []);
        const prompt = this.#browser.hasRetainedConversation(conversation)
          ? compileBrowserContinuationPrompt(context, turn.token)
          : compileBrowserPrompt(context, turn.token);
        try {
          await this.#browser.startTurn(conversation, prompt, this.#config);
        } catch (error) {
          this.#broker.end(request);
          throw error;
        }
      } else {
        this.#broker.updateTools(request, context.tools ?? []);
      }

      const timeoutSignal = AbortSignal.timeout(this.#config.turnTimeoutMs);
      const actionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const action = await this.#broker.nextAction(request, actionSignal);
      if (action.type === "tool") {
        pushToolCall(stream, model, action);
        return;
      }

      await this.#browser.finishTurn(conversation, this.#config, signal);
      pushText(stream, model, action.answer);
      this.#broker.end(request);
    } catch (error) {
      this.#broker.end(request);
      await this.#browser.invalidateSession(conversation).catch(() => undefined);
      pushError(stream, model, error);
    }
  }
}
