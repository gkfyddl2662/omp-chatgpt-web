import { ChatGptWebProvider } from "../provider/chatgpt-web-provider.js";

export interface OmpModelRequest {
  prompt: string;
}

export interface OmpModelResponse {
  text: string;
  provider: "chatgpt-web";
}

/**
 * Thin adapter used by the future OMP extension layer.
 *
 * The adapter intentionally exposes only inference. Tool execution remains
 * outside this layer and will be connected later through native MCP.
 */
export class OmpChatGptWebModelAdapter {
  readonly #provider: ChatGptWebProvider;

  constructor(provider = new ChatGptWebProvider()) {
    this.#provider = provider;
  }

  get modelId(): "chatgpt-web" {
    return "chatgpt-web";
  }

  async complete(request: OmpModelRequest): Promise<OmpModelResponse> {
    return {
      provider: "chatgpt-web",
      text: await this.#provider.complete(request.prompt),
    };
  }
}
