import { randomBytes } from "node:crypto";
import type {
  CapabilityToken,
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  TurnBinding,
} from "./types.js";

function mintToken(): CapabilityToken {
  return randomBytes(32).toString("base64url");
}

/**
 * Maps opaque, short-lived capability tokens visible to ChatGPT MCP calls to a
 * private OMP session/turn binding.
 *
 * Internal OMP handles are never exposed to the model.
 */
export class CapabilityBroker {
  readonly #bindings = new Map<CapabilityToken, TurnBinding>();

  bind(binding: TurnBinding): CapabilityToken {
    if (binding.signal.aborted) {
      throw new Error("Cannot bind an already-aborted OMP turn.");
    }

    let token = mintToken();
    while (this.#bindings.has(token)) token = mintToken();

    this.#bindings.set(token, binding);
    binding.signal.addEventListener("abort", () => this.#bindings.delete(token), {
      once: true,
    });
    return token;
  }

  revoke(token: CapabilityToken): void {
    this.#bindings.delete(token);
  }

  revokeSession(sessionId: string): void {
    for (const [token, binding] of this.#bindings) {
      if (binding.sessionId === sessionId) this.#bindings.delete(token);
    }
  }

  async listTools(token: CapabilityToken): Promise<ToolDefinition[]> {
    return await this.#get(token).runtime.listTools();
  }

  async invoke(
    token: CapabilityToken,
    request: ToolExecutionRequest,
    onUpdate?: (partial: ToolExecutionResult) => void,
  ): Promise<ToolExecutionResult> {
    const binding = this.#get(token);
    return await binding.runtime.invokeTool(request, {
      signal: binding.signal,
      onUpdate,
    });
  }

  #get(token: CapabilityToken): TurnBinding {
    const binding = this.#bindings.get(token);
    if (!binding) throw new Error("Unknown or expired turn capability.");
    if (binding.signal.aborted) {
      this.#bindings.delete(token);
      throw new Error("OMP turn capability has been aborted.");
    }
    return binding;
  }
}
