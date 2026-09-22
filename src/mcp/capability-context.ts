export interface CapabilityContext {
  token: string;
  sessionId: string;
  turnId: string;
  cwd: string;
}

/**
 * Converts an opaque MCP capability into request-local execution context.
 * The model never receives internal OMP session objects.
 */
export class CapabilityContextRegistry {
  readonly #contexts = new Map<string, CapabilityContext>();

  register(context: CapabilityContext): void {
    this.#contexts.set(context.token, context);
  }

  resolve(token: string): CapabilityContext {
    const context = this.#contexts.get(token);
    if (!context) {
      throw new Error("Unknown or expired MCP capability.");
    }
    return context;
  }

  revoke(token: string): void {
    this.#contexts.delete(token);
  }
}
