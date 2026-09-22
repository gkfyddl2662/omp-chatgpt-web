import type { CapabilityBroker } from "../capability-broker.js";
import type { ToolExecutionRequest } from "../types.js";

export interface OmpNativeMcpServerOptions {
  broker: CapabilityBroker;
}

/**
 * MCP boundary skeleton.
 *
 * This is intentionally transport-agnostic. OpenAI Secure MCP Tunnel will
 * connect to this boundary in the next phase.
 */
export class OmpNativeMcpServer {
  readonly #broker: CapabilityBroker;

  constructor(options: OmpNativeMcpServerOptions) {
    this.#broker = options.broker;
  }

  async listTools(capability: string) {
    return this.#broker.listTools(capability);
  }

  async callTool(
    capability: string,
    request: ToolExecutionRequest,
  ) {
    return this.#broker.invoke(capability, request);
  }
}
