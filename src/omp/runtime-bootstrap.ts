import { CapabilityBroker } from "../capability-broker.js";
import { OmpToolDispatcher } from "./tool-dispatcher.js";
import { RegistryBackedOmpRuntime } from "./registry-runtime.js";
import { createReadTool } from "./tools/read-tool.js";
import { McpToolCallRouter } from "../mcp/tool-call-router.js";
import { CapabilityContextRegistry } from "../mcp/capability-context.js";
import { OmpNativeMcpServer } from "../mcp/omp-native-mcp-server.js";

export function createBootstrapRuntime() {
  const runtime = new RegistryBackedOmpRuntime();
  runtime.register(createReadTool());

  const dispatcher = new OmpToolDispatcher(runtime);
  const broker = new CapabilityBroker();
  const contexts = new CapabilityContextRegistry();
  const router = new McpToolCallRouter(contexts, broker);
  const mcp = new OmpNativeMcpServer({ broker, router });

  return {
    runtime,
    dispatcher,
    broker,
    contexts,
    router,
    mcp,
  };
}
