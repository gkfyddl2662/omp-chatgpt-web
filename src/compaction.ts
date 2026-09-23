import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

export const OMP_SUMMARIZATION_SYSTEM_MARKER =
  "Summarize user–AI coding-assistant conversations in the exact specified structured format.";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      return Reflect.get(part, "type") === "text"
        ? String(Reflect.get(part, "text") ?? "")
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function isOmpCompactionContext(
  context: Context,
  options?: Pick<SimpleStreamOptions, "toolChoice">,
): boolean {
  const system = (context.systemPrompt ?? []).join("\n");
  const userMessages = context.messages
    .filter(message => message.role === "user")
    .map(message => textContent(message.content));
  const userText = userMessages.join("\n");

  const structuredSummary =
    system.includes(OMP_SUMMARIZATION_SYSTEM_MARKER) &&
    userText.includes("<conversation>") &&
    userText.includes("</conversation>");
  if (structuredSummary) return true;

  const lastUser = userMessages[userMessages.length - 1] ?? "";
  const handoff =
    options?.toolChoice === "none" &&
    lastUser.includes("Write a handoff document for another instance of yourself.") &&
    lastUser.includes("The handoff MUST be sufficient for seamless continuation without access to this conversation.") &&
    lastUser.includes("Output ONLY the handoff document.");
  return handoff;
}

export function compileCompactionPrompt(context: Context): string {
  const system = (context.systemPrompt ?? []).join("\n\n").trim();
  const messages = context.messages
    .map(message => {
      const content = textContent(message.content);
      if (!content) return "";
      return message.role.toUpperCase() + ":\n" + content;
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "Follow the SYSTEM instructions below exactly.",
    "This is a text-only OMP context-maintenance request (compaction/handoff).",
    "Do not perform the coding task itself, even if the embedded live system prompt describes coding tools.",
    "Do not use apps, tools, web search, files, MCP, or code execution.",
    "Return only the requested summary text. Do not explain what you are doing.",
    "",
    "SYSTEM:",
    system || "(none)",
    "",
    "MESSAGES:",
    messages || "(none)",
  ].join("\n");
}


function stripEmbeddedConversation(text: string): string {
  return text.replace(
    /<conversation>[\s\S]*?<\/conversation>/g,
    [
      "<conversation>",
      "[The full source conversation is already present in this retained ChatGPT thread.",
      "Summarize that retained conversation instead of expecting it to be repeated here.]",
      "</conversation>",
    ].join("\n"),
  );
}

export function compileRetainedCompactionPrompt(context: Context): string {
  const system = (context.systemPrompt ?? []).join("\n\n").trim();
  const userMessages = context.messages
    .filter(message => message.role === "user")
    .map(message => textContent(message.content))
    .filter(Boolean);
  const request = stripEmbeddedConversation(userMessages[userMessages.length - 1] ?? "");

  return [
    "This is an OMP context-compaction request for the SAME ChatGPT conversation you have been using as the model backend.",
    "Use the conversation history already present in this ChatGPT thread as the source to compact.",
    "Do not perform the coding task itself.",
    "Do not call apps, MCP, web search, files, or any other tools for this compaction message.",
    "Return ONLY the requested compacted summary/handoff text.",
    "",
    "OMP COMPACTION SYSTEM INSTRUCTIONS",
    system || "(none)",
    "",
    "OMP COMPACTION REQUEST",
    request || "Summarize the retained conversation according to the OMP compaction system instructions above.",
  ].join("\n");
}
