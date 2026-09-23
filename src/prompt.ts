import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part || typeof part !== "object") return String(part ?? "");
    const type = Reflect.get(part, "type");
    if (type === "text") return String(Reflect.get(part, "text") ?? "");
    if (type === "image") {
      const mime = String(Reflect.get(part, "mimeType") ?? "image/*");
      return "[image omitted from browser prompt: " + mime + "]";
    }
    if (type === "thinking") return "[prior assistant thinking omitted]";
    if (type === "redactedThinking") return "[prior assistant thinking redacted]";
    if (type === "toolCall") {
      return (
        "[tool call " +
        String(Reflect.get(part, "name") ?? "") +
        " id=" +
        String(Reflect.get(part, "id") ?? "") +
        "] " +
        JSON.stringify(Reflect.get(part, "arguments") ?? {})
      );
    }
    return "[" + String(type ?? "content") + "]";
  }).join("\n");
}

function renderMessage(message: Message): string {
  if (message.role === "user") {
    return "<user>\n" + textParts(message.content) + "\n</user>";
  }
  if (message.role === "toolResult") {
    return (
      '<tool_result name="' +
      message.toolName +
      '" id="' +
      message.toolCallId +
      '" error="' +
      String(message.isError) +
      '">\n' +
      textParts(message.content) +
      "\n</tool_result>"
    );
  }
  if (message.role === "assistant") {
    return "<assistant>\n" + textParts(message.content) + "\n</assistant>";
  }
  return "<developer>\n" + textParts(message.content) + "\n</developer>";
}

function compactToolInventory(tools: readonly Tool[]): string {
  if (tools.length === 0) return "(none)";
  return tools
    .map(tool => "- " + tool.name + ": " + tool.description.replace(/\s+/g, " ").trim())
    .join("\n");
}

export function compileBrowserPrompt(context: Context, turnToken: string): string {
  const system = (context.systemPrompt ?? []).join("\n\n");
  const history = context.messages.map(renderMessage).join("\n\n");
  const tools = context.tools ?? [];

  return [
    "You are the MODEL BACKEND for an active Oh My Pi (OMP) agent turn.",
    "You are not a reviewer, subagent, or advisor. Your response is the response OMP will treat as its model output.",
    "",
    "TURN CONTRACT",
    "- The outer OMP runtime owns session state, /goal state, approvals, tool execution, and persistence.",
    "- You own reasoning and decide which OMP tool to call next.",
    "- Use the connected OMP Local MCP app for every harness action.",
    "- First use omp_tool_inventory when you need an exact tool schema, then omp_tool_call. Inventory query is optional; omit it to list tools, or use one or more search keywords.",
    "- omp_tool_call blocks until outer OMP executes that native tool and returns its real result.",
    "- The tool list is turn-local and may include dynamic tools such as goal, task, hub, MCP tools, LSP, or extensions.",
    "- Never claim a tool side effect unless omp_tool_call returned success.",
    "- Do NOT finish by merely writing prose in the ChatGPT UI.",
    "- When the OMP model turn is ready to return a normal assistant answer, call omp_turn_complete with the complete final answer.",
    "- If a goal is active, use the real goal tool from the OMP inventory when its semantics require get/complete/resume/drop.",
    "",
    "TURN TOKEN",
    turnToken,
    "",
    "ACTIVE OMP TOOL SUMMARY",
    compactToolInventory(tools),
    "",
    "OMP SYSTEM PROMPT",
    system || "(none)",
    "",
    "OMP CONVERSATION",
    history || "(empty)",
  ].join("\n");
}


function continuationMessages(context: Context): Message[] {
  let lastAssistant = -1;
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    if (context.messages[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }

  const suffix = context.messages.slice(lastAssistant + 1);
  if (suffix.length > 0) return suffix;

  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message && message.role !== "assistant") return [message];
  }
  return [];
}

export function compileBrowserContinuationPrompt(context: Context, turnToken: string): string {
  const system = (context.systemPrompt ?? []).join("\n\n");
  const delta = continuationMessages(context).map(renderMessage).join("\n\n");
  const tools = context.tools ?? [];

  return [
    "Continue the SAME retained ChatGPT conversation as the MODEL BACKEND for the next Oh My Pi (OMP) turn.",
    "Do not restate or re-ingest the earlier conversation: it is already present in this ChatGPT thread.",
    "",
    "TURN CONTRACT",
    "- The outer OMP runtime owns session state, /goal state, approvals, tool execution, and persistence.",
    "- You own reasoning and decide which OMP tool to call next.",
    "- Use the connected OMP Local MCP app for every harness action.",
    "- First use omp_tool_inventory when you need an exact tool schema, then omp_tool_call. Inventory query is optional; omit it to list tools, or use one or more search keywords.",
    "- Never claim a tool side effect unless omp_tool_call returned success.",
    "- When this OMP model turn is ready to return a normal assistant answer, call omp_turn_complete with the complete final answer.",
    "",
    "NEW TURN TOKEN",
    turnToken,
    "",
    "CURRENT OMP TOOL SUMMARY",
    compactToolInventory(tools),
    "",
    "CURRENT OMP SYSTEM PROMPT",
    system || "(none)",
    "",
    "NEW OMP INPUT SINCE THE PREVIOUS RETAINED TURN",
    delta || "(no new textual message; continue from current OMP state)",
  ].join("\n");
}
