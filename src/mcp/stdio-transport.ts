import { OmpMcpProtocolServer, type JsonRpcRequest } from "./protocol-server.js";

/**
 * Line-delimited JSON transport used by tunnel-client style stdio MCP wiring.
 */
export async function handleStdioLine(
  line: string,
  server: OmpMcpProtocolServer,
): Promise<string> {
  const request = JSON.parse(line) as JsonRpcRequest;
  const response = await server.handle(request);
  return JSON.stringify(response);
}

export async function runStdioLoop(
  server: OmpMcpProtocolServer,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  process.stdin.on("data", async (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;

      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      const result = await handleStdioLine(line, server);
      process.stdout.write(`${result}\n`);
    }
  });
}
