import type { OmpToolRuntime, ToolDefinition, ToolExecutionRequest, ToolExecutionResult } from "../types.js";

/**
 * Single execution boundary for MCP -> OMP tools.
 *
 * Future implementation will delegate to OMP's native tool pipeline so that
 * approvals, hooks, extensions and cancellation are preserved.
 */
export class OmpToolDispatcher {
  constructor(private readonly runtime: OmpToolRuntime) {}

  listTools(): Promise<ToolDefinition[]> | ToolDefinition[] {
    return this.runtime.listTools();
  }

  invoke(
    request: ToolExecutionRequest,
    options: {
      signal: AbortSignal;
      onUpdate?: (partial: ToolExecutionResult) => void;
    },
  ): Promise<ToolExecutionResult> {
    return this.runtime.invokeTool(request, options);
  }
}
