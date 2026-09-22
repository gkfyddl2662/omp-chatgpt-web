export type CapabilityToken = string;

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolExecutionRequest {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionResult {
  isError: boolean;
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  details?: unknown;
}

export interface OmpToolRuntime {
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  invokeTool(
    request: ToolExecutionRequest,
    options: {
      signal: AbortSignal;
      onUpdate?: (partial: ToolExecutionResult) => void;
    },
  ): Promise<ToolExecutionResult>;
}

export interface TurnBinding {
  sessionId: string;
  turnId: string;
  cwd: string;
  runtime: OmpToolRuntime;
  signal: AbortSignal;
  createdAt: number;
}
