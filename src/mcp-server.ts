import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TurnBroker } from "./turn-broker.js";

const SERVER_NAME = "omp-chatgpt-web";
const SERVER_VERSION = "0.2.0";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function requestProtocolVersion(
  request: JsonRpcRequest,
  httpProtocolVersion?: string,
): string | undefined {
  const meta = request.params?._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const version = (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"];
    if (typeof version === "string" && version) return version;
  }
  return httpProtocolVersion;
}

function completeResult(
  request: JsonRpcRequest,
  result: Record<string, unknown>,
  options: { cacheable?: boolean; httpProtocolVersion?: string } = {},
): Record<string, unknown> {
  const version = request.method === "server/discover"
    ? MODERN_PROTOCOL_VERSION
    : requestProtocolVersion(request, options.httpProtocolVersion);
  if (version !== MODERN_PROTOCOL_VERSION) return result;

  const existingMeta =
    result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
      ? result._meta as Record<string, unknown>
      : {};

  return {
    resultType: "complete",
    ...result,
    ...(options.cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
    _meta: {
      ...existingMeta,
      "io.modelcontextprotocol/serverInfo": {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    },
  };
}

function rpcComplete(
  request: JsonRpcRequest,
  result: Record<string, unknown>,
  options: { cacheable?: boolean; httpProtocolVersion?: string } = {},
) {
  return rpcResult(request.id, completeResult(request, result, options));
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string,string> = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("MCP request exceeds 2 MiB");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export interface McpTraceEntry {
  at: string;
  method: string;
  id: string | number | null;
  protocolVersion?: string;
  ok: boolean;
  errorCode?: number;
}

export interface McpServerHandle {
  url: string;
  trace(): McpTraceEntry[];
  close(): Promise<void>;
}

export async function createMcpServer(options: {
  host: string;
  port: number;
  broker: TurnBroker;
}): Promise<McpServerHandle> {
  const trace: McpTraceEntry[] = [];
  const pushTrace = (entry: McpTraceEntry) => {
    trace.push(entry);
    if (trace.length > 50) trace.splice(0, trace.length - 50);
  };

  const execute = async (
    request: JsonRpcRequest,
    signal: AbortSignal,
    httpProtocolVersion?: string,
  ): Promise<unknown | undefined> => {
    const method = request.method;
    if (!method) return rpcError(request.id, -32600, "Invalid Request");

    if (method === "notifications/initialized") return undefined;
    if (method === "ping") {
      return rpcComplete(request, {}, { httpProtocolVersion });
    }

    if (method === "server/discover") {
      return rpcComplete(
        request,
        {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          instructions:
            "This MCP server bridges ChatGPT to the live Oh My Pi tool surface. " +
            "Use omp_tool_inventory to inspect the exact current OMP tools, " +
            "omp_tool_call to request one native OMP tool, and omp_turn_complete " +
            "to finish the current OMP model turn.",
        },
        { cacheable: true, httpProtocolVersion },
      );
    }

    if (method === "initialize") {
      return rpcResult(request.id, {
        protocolVersion:
          typeof request.params?.protocolVersion === "string"
            ? request.params.protocolVersion
            : LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    if (method === "tools/list") {
      return rpcComplete(request, {
        tools: [
          {
            name: "omp_tool_inventory",
            description:
              "List tools available in the current Oh My Pi turn. Call this before using a tool when you need its exact schema. The outer OMP runtime remains authoritative for tool execution, approvals, session state, and Goal state.",
            inputSchema: {
              type: "object",
              properties: {
                turn_token: { type: "string" },
                query: { type: "string" },
                offset: { type: "integer", minimum: 0, default: 0 },
                limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
                include_schema: { type: "boolean", default: true },
              },
              required: ["turn_token"],
              additionalProperties: false,
            },
          },
          {
            name: "omp_tool_call",
            description:
              "Invoke one exact OMP tool from the current turn. Use a name returned by omp_tool_inventory and pass arguments matching that tool's schema. OMP, not ChatGPT, executes the call and applies its normal approval and Goal lifecycle.",
            inputSchema: {
              type: "object",
              properties: {
                turn_token: { type: "string" },
                name: { type: "string" },
                arguments: { type: "object", additionalProperties: true },
              },
              required: ["turn_token", "name"],
              additionalProperties: false,
            },
          },
          {
            name: "omp_turn_complete",
            description:
              "Finish the current OMP model turn with the final assistant answer. Do not call while an OMP tool is still in flight.",
            inputSchema: {
              type: "object",
              properties: {
                turn_token: { type: "string" },
                answer: { type: "string" },
              },
              required: ["turn_token", "answer"],
              additionalProperties: false,
            },
          },
        ],
      }, { cacheable: true, httpProtocolVersion });
    }

    if (method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(request.id, -32602, "tools/call requires params.name and object params.arguments");
      }
      const input = args as Record<string, unknown>;
      const token = input.turn_token;
      if (typeof token !== "string" || !token) {
        return rpcError(request.id, -32602, "turn_token is required");
      }

      if (name === "omp_tool_inventory") {
        const page = options.broker.inventory(token, {
          query: typeof input.query === "string" ? input.query : undefined,
          offset: typeof input.offset === "number" ? input.offset : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
          includeSchema: typeof input.include_schema === "boolean" ? input.include_schema : undefined,
        });
        return rpcComplete(request, {
          content: [{ type: "text", text: JSON.stringify(page) }],
          structuredContent: page,
        }, { httpProtocolVersion });
      }

      if (name === "omp_tool_call") {
        const toolName = input.name;
        if (typeof toolName !== "string" || !toolName) {
          return rpcError(request.id, -32602, "omp_tool_call requires name");
        }
        const toolArgs =
          input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
            ? input.arguments as Record<string, unknown>
            : {};
        try {
          const receipt = await options.broker.requestTool(token, toolName, toolArgs, signal);
          return rpcComplete(request, {
            content: [{ type: "text", text: JSON.stringify(receipt) }],
            structuredContent: receipt,
            ...(receipt.is_error ? { isError: true } : {}),
          }, { httpProtocolVersion });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return rpcComplete(request, {
            content: [{ type: "text", text: message }],
            structuredContent: { error: message },
            isError: true,
          }, { httpProtocolVersion });
        }
      }

      if (name === "omp_turn_complete") {
        if (typeof input.answer !== "string") {
          return rpcError(request.id, -32602, "omp_turn_complete requires answer");
        }
        options.broker.complete(token, input.answer);
        return rpcComplete(request, {
          content: [{ type: "text", text: "OMP turn completed." }],
          structuredContent: { completed: true },
        }, { httpProtocolVersion });
      }

      return rpcError(request.id, -32601, "Unknown MCP tool: " + name);
    }

    return rpcError(request.id, -32601, "Method not found: " + method);
  };

  let server: Server;
  server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      return sendJson(response, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(404);
      return response.end();
    }

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const input = await readJson(request);
      const calls = Array.isArray(input) ? input : [input];
      const outputs: unknown[] = [];
      for (const raw of calls) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          outputs.push(rpcError(null, -32600, "Invalid Request"));
          continue;
        }
        const protocolHeader = request.headers["mcp-protocol-version"];
        const httpProtocolVersion = Array.isArray(protocolHeader)
          ? protocolHeader[0]
          : protocolHeader;
        const rpcRequest = raw as JsonRpcRequest;
        const output = await execute(
          rpcRequest,
          controller.signal,
          httpProtocolVersion,
        );
        if (output !== undefined) outputs.push(output);

        const errorCode =
          output &&
          typeof output === "object" &&
          !Array.isArray(output) &&
          Reflect.get(output, "error") &&
          typeof Reflect.get(output, "error") === "object"
            ? Number(Reflect.get(Reflect.get(output, "error") as object, "code"))
            : undefined;

        pushTrace({
          at: new Date().toISOString(),
          method: rpcRequest.method || "(missing)",
          id: rpcRequest.id ?? null,
          protocolVersion: requestProtocolVersion(rpcRequest, httpProtocolVersion),
          ok: errorCode === undefined,
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
      }
      if (outputs.length === 0) {
        response.writeHead(202);
        return response.end();
      }
      return sendJson(response, 200, Array.isArray(input) ? outputs : outputs[0]);
    } catch (error) {
      return sendJson(
        response,
        400,
        rpcError(null, -32700, error instanceof Error ? error.message : String(error)),
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo | null;
      if (!address) {
        server.close();
        reject(new Error("MCP server did not expose a listening address"));
        return;
      }
      resolve({
        url: "http://" + options.host + ":" + address.port + "/mcp",
        trace: () => trace.slice(),
        close: () => new Promise<void>((done, fail) => {
          server.close(error => error ? fail(error) : done());
        }),
      });
    });
  });
}
