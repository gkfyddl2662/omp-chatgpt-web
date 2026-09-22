import { CapabilityBroker } from "../capability-broker.js";
import { OmpNativeMcpServer } from "./omp-native-mcp-server.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";
import { runStdioLoop } from "./stdio-transport.js";

/**
 * stdio entrypoint intended for OpenAI Secure MCP Tunnel's local command.
 *
 * Real OMP runtime injection will replace the placeholder broker binding.
 */
const broker = new CapabilityBroker();
const server = new OmpNativeMcpServer(broker);
const protocol = new OmpMcpProtocolServer(server);

await runStdioLoop(protocol);
