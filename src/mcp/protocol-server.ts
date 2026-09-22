import type { OmpNativeMcpServer } from "./omp-native-mcp-server.js";

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export class OmpMcpProtocolServer {
  constructor(private readonly server: OmpNativeMcpServer) {}

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      const id = request.id ?? null;
      const capability = String(request.params?.capability ?? "");

      switch (request.method) {
        case "initialize":
          return this.ok(id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "omp-chatgpt-web", version: "0.0.0" },
          });
        case "tools/list":
          return this.ok(id, { tools: await this.server.listTools(capability) });
        case "tools/call": {
          const name = String(request.params?.name ?? "");
          const argumentsValue = (request.params?.arguments ?? {}) as Record<string, unknown>;
          return this.ok(id, await this.server.callTool(capability, {
            callId: String(id ?? crypto.randomUUID()),
            name,
            arguments: argumentsValue,
          }));
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
      }
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }
}
