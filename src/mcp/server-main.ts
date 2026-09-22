import { createBootstrapRuntime } from "../omp/runtime-bootstrap.js";
import { OmpMcpProtocolServer } from "./protocol-server.js";
import { runStdioLoop } from "./stdio-transport.js";

/**
 * stdio entrypoint intended for OpenAI Secure MCP Tunnel's local command.
 */
const runtime = createBootstrapRuntime();
const protocol = new OmpMcpProtocolServer(runtime.mcp);

await runStdioLoop(protocol);
