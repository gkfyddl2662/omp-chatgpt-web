import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeComposerInsertMode,
  parseComposerInsertMode,
} from "../src/config.js";

test("composer insert mode accepts current and legacy direct-editor aliases", () => {
  assert.equal(parseComposerInsertMode("default"), "default");
  assert.equal(parseComposerInsertMode("editor"), "editor");
  assert.equal(parseComposerInsertMode("prosemirror"), "editor");
  assert.equal(parseComposerInsertMode("lexical"), "editor");
  assert.equal(parseComposerInsertMode("nope"), undefined);

  assert.equal(normalizeComposerInsertMode("editor"), "editor");
  assert.equal(normalizeComposerInsertMode("lexical"), "editor");
  assert.equal(normalizeComposerInsertMode(undefined), "default");
});
