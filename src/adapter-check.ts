import assert from "node:assert/strict";
import { createOmpChatGptWebExtension } from "./omp/extension.js";

const extension = createOmpChatGptWebExtension();

assert.equal(extension.manifest.id, "omp-chatgpt-web");
assert.equal(extension.models.length, 1);
assert.equal(extension.models[0]?.id, "chatgpt-web");
assert.equal(extension.models[0]?.capabilities.tools, false);

console.log("OMP adapter boundary check: PASS");
