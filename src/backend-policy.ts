/**
 * Fail-closed backend policy.
 *
 * This project intentionally permits only normal ChatGPT Web chat for model
 * inference. Codex, ChatGPT Work, and OpenAI API inference must never be used
 * as fallback paths.
 */
export type InferenceBackend =
  | { kind: "chatgpt-web"; surface: "normal-chat" }
  | { kind: "codex" }
  | { kind: "chatgpt-work" }
  | { kind: "openai-api"; endpoint?: string }
  | { kind: "other"; name: string };

export function assertAllowedInferenceBackend(
  backend: InferenceBackend,
): asserts backend is { kind: "chatgpt-web"; surface: "normal-chat" } {
  if (backend.kind !== "chatgpt-web" || backend.surface !== "normal-chat") {
    throw new Error(
      `Forbidden inference backend: ${backend.kind}. Only normal ChatGPT Web chat is allowed.`,
    );
  }
}

export const BACKEND_INVARIANTS = Object.freeze({
  inference: "normal ChatGPT Web chat only",
  harness: "Oh My Pi",
  toolCalling: "ChatGPT native MCP only",
  transport: "OpenAI Secure MCP Tunnel",
  localExecution: "OMP",
  codex: "forbidden",
  chatgptWork: "forbidden",
  apiInference: "forbidden",
  fallback: "none",
} as const);
