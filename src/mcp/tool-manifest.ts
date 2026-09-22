import type { ToolDefinition } from "../types.js";

export function createOmpNativeToolManifest(
  tools: ToolDefinition[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "OMP tool",
    inputSchema: tool.inputSchema,
  }));
}
