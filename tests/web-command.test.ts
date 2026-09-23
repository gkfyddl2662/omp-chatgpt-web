import assert from "node:assert/strict";
import test from "node:test";
import {
  getWebArgumentCompletions,
  parseWebCommand,
} from "../src/web-command.js";

test("plain /web shows help", () => {
  assert.deepEqual(parseWebCommand(""), { kind: "help" });
  assert.deepEqual(parseWebCommand("help"), { kind: "help" });
});

test("short Web commands parse to explicit actions", () => {
  assert.deepEqual(parseWebCommand("start"), { kind: "start" });
  assert.deepEqual(parseWebCommand("use"), { kind: "use" });
  assert.deepEqual(parseWebCommand("open"), { kind: "open" });
  assert.deepEqual(parseWebCommand("status"), { kind: "status" });
  assert.deepEqual(parseWebCommand("config"), { kind: "config" });
  assert.deepEqual(parseWebCommand("limit"), { kind: "limit" });
  assert.deepEqual(parseWebCommand("limit 3"), { kind: "limit", value: 3 });
  assert.deepEqual(parseWebCommand("limit off"), { kind: "limit", value: -1 });
  assert.deepEqual(parseWebCommand("limit default"), { kind: "limit", value: "default" });
});

test("/web tunnel defaults to idempotent start and supports lifecycle actions", () => {
  assert.deepEqual(parseWebCommand("tunnel"), { kind: "tunnel", action: "start" });
  assert.deepEqual(parseWebCommand("tunnel start"), { kind: "tunnel", action: "start" });
  assert.deepEqual(parseWebCommand("tunnel on"), { kind: "tunnel", action: "start" });
  assert.deepEqual(parseWebCommand("tunnel stop"), { kind: "tunnel", action: "stop" });
  assert.deepEqual(parseWebCommand("tunnel off"), { kind: "tunnel", action: "stop" });
  assert.deepEqual(parseWebCommand("tunnel restart"), { kind: "tunnel", action: "restart" });
  assert.deepEqual(parseWebCommand("tunnel status"), { kind: "tunnel", action: "status" });
});

test("/web set and unset preserve values with spaces", () => {
  assert.deepEqual(parseWebCommand("set connector My OMP"), {
    kind: "set",
    key: "connector",
    value: "My OMP",
  });
  assert.deepEqual(parseWebCommand("set browser C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), {
    kind: "set",
    key: "browser",
    value: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  assert.deepEqual(parseWebCommand("set insert lexical"), {
    kind: "set",
    key: "insert",
    value: "lexical",
  });
  assert.deepEqual(parseWebCommand("unset api"), { kind: "unset", key: "api" });
  assert.deepEqual(parseWebCommand("unset insert"), { kind: "unset", key: "insert" });
});

test("invalid subcommands fail with actionable usage", () => {
  const badTunnel = parseWebCommand("tunnel explode");
  assert.equal(badTunnel.kind, "invalid");
  if (badTunnel.kind === "invalid") assert.match(badTunnel.message, /tunnel/);

  const badLimit = parseWebCommand("limit nope");
  assert.equal(badLimit.kind, "invalid");
  if (badLimit.kind === "invalid") assert.match(badLimit.message, /\/web limit/);

  const badSet = parseWebCommand("set connector");
  assert.equal(badSet.kind, "invalid");
  if (badSet.kind === "invalid") assert.match(badSet.message, /\/web set/);
});

test("argument completion covers root, tunnel, set, and unset commands", () => {
  assert.deepEqual(
    getWebArgumentCompletions("st")?.map(item => item.label),
    ["start", "status"],
  );
  assert.deepEqual(
    getWebArgumentCompletions("limit o")?.map(item => item.label),
    ["off"],
  );
  assert.deepEqual(
    getWebArgumentCompletions("tunnel r")?.map(item => item.label),
    ["restart"],
  );
  assert.deepEqual(
    getWebArgumentCompletions("set con")?.map(item => item.label),
    ["connector"],
  );
  assert.deepEqual(
    getWebArgumentCompletions("set ins")?.map(item => item.label),
    ["insert"],
  );
  assert.deepEqual(
    getWebArgumentCompletions("unset tun")?.map(item => item.label),
    ["tunnel", "tunnel-bin"],
  );
  assert.equal(getWebArgumentCompletions("set connector My "), null);
});
