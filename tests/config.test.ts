import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPOSER_INSERT_MODE,
  normalizeComposerInsertMode,
  parseComposerInsertMode,
} from "../src/config.js";

test("composer insert mode defaults to direct editor insertion and preserves aliases", () => {
  assert.equal(DEFAULT_COMPOSER_INSERT_MODE, "editor");
  assert.equal(parseComposerInsertMode("default"), "default");
  assert.equal(parseComposerInsertMode("editor"), "editor");
  assert.equal(parseComposerInsertMode("prosemirror"), "editor");
  assert.equal(parseComposerInsertMode("lexical"), "editor");
  assert.equal(parseComposerInsertMode("nope"), undefined);

  assert.equal(normalizeComposerInsertMode("editor"), "editor");
  assert.equal(normalizeComposerInsertMode("lexical"), "editor");
  assert.equal(normalizeComposerInsertMode(undefined), "editor");
  assert.equal(normalizeComposerInsertMode("default"), "default");
});
