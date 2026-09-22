import { ompChatgptWebManifest } from "./extension-manifest.js";
import { createChatGptWebModelRegistration } from "./omp-model-registry.js";

/**
 * OMP integration boundary.
 *
 * This object is intentionally independent from the browser runtime. The
 * final OMP extension adapter will translate this into the host API.
 */
export function createOmpChatGptWebExtension() {
  return {
    manifest: ompChatgptWebManifest,
    models: [createChatGptWebModelRegistration()],
  };
}
