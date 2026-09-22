import { ChatGptBrowserRuntime } from "../chatgpt-web/browser-runtime.js";
import { assertAllowedInferenceBackend } from "../backend-policy.js";

/**
 * Provider boundary between OMP and the normal ChatGPT Web surface.
 *
 * This deliberately does not implement tool calling. Tool calls will be routed
 * through native MCP -> OMP capability broker in the next phase.
 */
export class ChatGptWebProvider {
  readonly #runtime: ChatGptBrowserRuntime;

  constructor(runtime = new ChatGptBrowserRuntime()) {
    assertAllowedInferenceBackend({
      kind: "chatgpt-web",
      surface: "normal-chat",
    });

    this.#runtime = runtime;
  }

  get id(): "chatgpt-web" {
    return "chatgpt-web";
  }

  async complete(prompt: string): Promise<string> {
    const result = await this.#runtime.runTurn({ prompt });
    return result.text;
  }
}
