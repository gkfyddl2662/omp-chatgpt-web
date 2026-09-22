import readline from "node:readline";
import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

const runtime = createBootstrapRuntime();
const protocol = new OmpMcpProtocolServer(runtime.mcp);

const controller = new AbortController();
const token = runtime.broker.bind({
  sessionId: "tunnel-smoke-session",
  turnId: "tunnel-smoke-turn",
  cwd: process.cwd(),
  runtime: runtime.runtime,
  signal: controller.signal,
  createdAt: Date.now(),
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    const response = await protocol.handle({
      ...request,
      params: {
        ...(request.params ?? {}),
        capability: request.params?.capability ?? token,
      },
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`);
  }
});
