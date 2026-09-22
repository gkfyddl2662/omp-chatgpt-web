import { ChatGptWebProvider } from "../provider/chatgpt-web-provider.js";

/**
 * OMP integration boundary.
 *
 * This intentionally keeps the provider registration isolated from the
 * ChatGPT Web runtime. The final adapter will map this object into OMP's
 * extension/provider API without introducing another inference path.
 */
export function createOmpChatGptWebExtension() {
  const provider = new ChatGptWebProvider();

  return {
    id: "omp-chatgpt-web",
    providers: [provider],
  };
}
