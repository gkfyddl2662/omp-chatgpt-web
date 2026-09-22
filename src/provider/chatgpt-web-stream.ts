import { ChatGptWebProvider } from "./chatgpt-web-provider.js";

export type ChatGptWebStreamEvent =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; error: Error };

/**
 * Converts the browser-backed ChatGPT Web completion into an async event stream.
 *
 * This is the boundary used later by OMP's streaming provider interface.
 */
export async function* streamChatGptWeb(
  provider: ChatGptWebProvider,
  prompt: string,
): AsyncGenerator<ChatGptWebStreamEvent> {
  yield { type: "start" };

  try {
    const text = await provider.complete(prompt);
    yield { type: "text_delta", text };
    yield { type: "done", text };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
