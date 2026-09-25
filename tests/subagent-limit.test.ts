import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WEB_SUBAGENT_LIMIT,
  normalizeWebSubagentLimit,
  WebSubagentLimiter,
} from "../src/subagent-limit.js";

test("subagent limiter defaults to a small hard cap", () => {
  assert.equal(DEFAULT_WEB_SUBAGENT_LIMIT, 4);
  assert.equal(normalizeWebSubagentLimit(undefined), 4);
  assert.equal(normalizeWebSubagentLimit(-1), -1);
  assert.equal(normalizeWebSubagentLimit(0), 0);
  assert.equal(normalizeWebSubagentLimit(7), 7);
});

test("subagent limiter blocks the first spawn beyond the configured root budget", () => {
  const limiter = new WebSubagentLimiter();
  limiter.retain("root");

  for (let index = 0; index < 4; index++) {
    const decision = limiter.trySpawn("root", "spawn-" + index, 4);
    assert.equal(decision.allowed, true);
    assert.equal(decision.used, index + 1);
  }

  const blocked = limiter.trySpawn("root", "spawn-4", 4);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 4);
  assert.equal(blocked.remaining, 0);
});

test("zero disables subagent spawning and minus one is unlimited", () => {
  const limiter = new WebSubagentLimiter();
  limiter.retain("blocked");
  assert.equal(limiter.trySpawn("blocked", "a", 0).allowed, false);

  limiter.retain("unlimited");
  for (let index = 0; index < 20; index++) {
    assert.equal(limiter.trySpawn("unlimited", "u-" + index, -1).allowed, true);
  }
  assert.equal(limiter.status("unlimited", -1).used, 20);
  assert.equal(limiter.status("unlimited", -1).remaining, null);
});

test("reused spawn keys still count as real child dispatches", () => {
  const limiter = new WebSubagentLimiter();
  limiter.retain("root");

  assert.equal(limiter.trySpawn("root", "same", 1).allowed, true);
  const repeated = limiter.trySpawn("root", "same", 1);
  assert.equal(repeated.allowed, false);
  assert.equal(repeated.used, 1);
  assert.equal(repeated.remaining, 0);
});

test("budget is released only after the last session in the root family shuts down", () => {
  const limiter = new WebSubagentLimiter();
  limiter.retain("root");
  limiter.retain("root");
  assert.equal(limiter.trySpawn("root", "a", 2).used, 1);

  limiter.release("root");
  assert.equal(limiter.status("root", 2).used, 1);

  limiter.release("root");
  assert.equal(limiter.status("root", 2).used, 0);
});
