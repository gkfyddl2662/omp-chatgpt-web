import type { CapabilityBroker } from "../capability-broker.js";
import type { ToolExecutionRequest } from "../types.js";
import { McpToolCallRouter } from "./tool-call-router.js";

export interface OmpNativeMcpServerOptions {
  broker: CapabilityBroker;
  router: McpToolCallRouter;
}

/**
 * MCP boundary.
 *
 * Authorization is resolved before any OMP tool execution. The tunnel only
 * transports requests; capability routing remains local.
 */
export class OmpNativeMcpServer {
  readonly #broker: CapabilityBroker;
  readonly #router: McpToolCallRouter;

  constructor(options: OmpNativeMcpServerOptions) {
    this.#broker = options.broker;
    this.#router = options.router;
  }

  async listTools(capability: string) {
    return this.#broker.listTools(capability);
  }

  async callTool(
    capability: string,
    request: ToolExecutionRequest,
  ) {
    return this.#router.call(capability, request);
  }
}
