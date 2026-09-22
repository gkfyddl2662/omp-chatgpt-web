import { CHATGPT_WEB_MODEL } from "./model-definition.js";
import { createOmpChatGptWebExtension } from "./extension.js";

export function getChatGptWebProviderRegistration() {
  const extension = createOmpChatGptWebExtension();

  return {
    extensionId: extension.id,
    models: [CHATGPT_WEB_MODEL],
    providers: extension.providers,
  };
}
