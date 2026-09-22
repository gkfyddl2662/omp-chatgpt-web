export const CHATGPT_WEB_MODEL = {
  id: "chatgpt-web",
  name: "ChatGPT Web",
  provider: "chatgpt-web",
  capabilities: {
    streaming: false,
    tools: false,
    vision: false,
  },
  constraints: {
    inferenceBackend: "normal-chatgpt-web-only",
    codex: "disabled",
    chatgptWork: "disabled",
    apiFallback: "disabled",
  },
} as const;
