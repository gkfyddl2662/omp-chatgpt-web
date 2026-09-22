import type { OmpToolRuntime, ToolDefinition, ToolExecutionRequest, ToolExecutionResult } from "../types.js";

export interface RegisteredOmpTool {
  definition: ToolDefinition;
  execute(
    request: ToolExecutionRequest,
    options: {
      signal: AbortSignal;
      onUpdate?: (partial: ToolExecutionResult) => void;
    },
  ): Promise<ToolExecutionResult>;
}

/**
 * Adapter used until the upstream OMP runtime dispatcher is injected.
 *
 * Keeps MCP independent from concrete tool implementations while preserving a
 * single execution boundary.
 */
export class RegistryBackedOmpRuntime implements OmpToolRuntime {
  readonly #tools = new Map<string, RegisteredOmpTool>();

  register(tool: RegisteredOmpTool): void {
    this.#tools.set(tool.definition.name, tool);
  }

  listTools(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  async invokeTool(
    request: ToolExecutionRequest,
    options: {
      signal: AbortSignal;
      onUpdate?: (partial: ToolExecutionResult) => void;
    },
  ): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(request.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown OMP tool: ${request.name}` }],
      };
    }

    return tool.execute(request, options);
  }
}
