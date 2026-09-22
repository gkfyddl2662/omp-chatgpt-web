import { CHATGPT_WEB_MODEL } from "./model-definition.js";
import { createOmpChatGptWebExtension } from "./extension.js";

export function getChatGptWebProviderRegistration() {
  const extension = createOmpChatGptWebExtension();

  return {
    manifest: extension.manifest,
    models: [CHATGPT_WEB_MODEL],
  };
}
