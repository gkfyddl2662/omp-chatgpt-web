export type NetworkVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const API_INFERENCE_PATH = /^\/v1\/(responses|chat\/completions|completions)(?:\/|$)/i;
const FORBIDDEN_CHATGPT_SURFACE = /^\/(codex|work)(?:\/|$)/i;

/**
 * Browser-level backstop for the project's inference invariants.
 *
 * Normal ChatGPT Web is allowed to use its own chatgpt.com backend APIs. Direct
 * OpenAI API inference and top-level Codex/Work navigation are blocked.
 */
export function classifyBrowserRequest(
  rawUrl: string,
  options: { navigation?: boolean } = {},
): NetworkVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: true };
  }

  if (url.hostname === "api.openai.com" && API_INFERENCE_PATH.test(url.pathname)) {
    return {
      allowed: false,
      reason: "OpenAI API model inference is forbidden",
    };
  }

  if (
    options.navigation === true &&
    (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com")) &&
    FORBIDDEN_CHATGPT_SURFACE.test(url.pathname)
  ) {
    return {
      allowed: false,
      reason: "Codex and ChatGPT Work surfaces are forbidden",
    };
  }

  return { allowed: true };
}
