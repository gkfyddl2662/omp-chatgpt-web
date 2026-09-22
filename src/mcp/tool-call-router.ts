import type { CapabilityBroker } from "../capability-broker.js";
import type { ToolExecutionRequest } from "../types.js";
import { CapabilityContextRegistry } from "./capability-context.js";

export class McpToolCallRouter {
  constructor(
    private readonly contexts: CapabilityContextRegistry,
    private readonly broker: CapabilityBroker,
  ) {}

  async call(
    capability: string,
    request: ToolExecutionRequest,
  ) {
    this.contexts.resolve(capability);
    return this.broker.invoke(capability, request);
  }
}
