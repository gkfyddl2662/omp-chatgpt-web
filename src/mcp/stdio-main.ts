import readline from "node:readline";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

/**
 * stdio entrypoint used by tunnel-client.
 *
 * Uses the same bootstrap runtime as local MCP smoke tests. The production
 * integration will replace this runtime with the live OMP session runtime.
 */

const runtime = createBootstrapRuntime();
const protocol = new OmpMcpProtocolServer(runtime.mcp);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    const response = await protocol.handle(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
  }
});
