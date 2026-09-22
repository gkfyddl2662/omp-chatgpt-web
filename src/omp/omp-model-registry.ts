import { ChatGptWebProvider } from "../provider/chatgpt-web-provider.js";

export interface OmpModelRegistration {
  id: string;
  provider: ChatGptWebProvider;
  contextWindow: number;
  capabilities: {
    tools: boolean;
    vision: boolean;
  };
}

/**
 * Phase 2 model registry boundary.
 *
 * Tool support intentionally remains false here. Native MCP will become the
 * only tool path in the following phase.
 */
export function createChatGptWebModelRegistration(): OmpModelRegistration {
  return {
    id: "chatgpt-web",
    provider: new ChatGptWebProvider(),
    contextWindow: 128000,
    capabilities: {
      tools: false,
      vision: false,
    },
  };
}
