import readline from "node:readline";
import { CapabilityBroker } from "../capability-broker.js";
import { OmpNativeMcpServer } from "./omp-native-mcp-server.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";

/**
 * stdio entrypoint used by tunnel-client.
 *
 * Real OMP runtime binding will inject a session-bound CapabilityBroker.
 * This entrypoint currently provides the transport loop.
 */

const broker = new CapabilityBroker();
const server = new OmpNativeMcpServer({ broker });
const protocol = new OmpMcpProtocolServer(server);

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
