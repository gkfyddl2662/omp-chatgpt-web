import type { ChildProcess } from "node:child_process";

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export function writeMcpRequest(child: ChildProcess, request: JsonRpcRequest): void {
  if (!child.stdin) throw new Error("MCP tunnel stdin is unavailable.");
  child.stdin.write(`${JSON.stringify(request)}\n`);
}

export function waitForMcpResponse(
  child: ChildProcess,
  timeoutMs = 5000,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for MCP response."));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) return;
      cleanup();
      resolve(JSON.parse(line));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
    };

    child.stdout?.on("data", onData);
    child.once("error", onError);
  });
}
