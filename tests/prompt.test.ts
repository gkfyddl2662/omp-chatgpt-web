import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@oh-my-pi/pi-ai";
import {
  compileBrowserContinuationPrompt,
  compileBrowserPrompt,
} from "../src/prompt.js";

function context(): Context {
  return {
    systemPrompt: ["You are OMP."],
    tools: [],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "old user request" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant answer" }],
        api: "chatgpt-web",
        provider: "chatgpt-web",
        model: "web",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: "new retained-turn request" }],
        timestamp: 3,
      },
    ],
  };
}

test("first browser seed includes full OMP history", () => {
  const prompt = compileBrowserPrompt(context(), "turn_seed");
  assert.match(prompt, /old user request/);
  assert.match(prompt, /old assistant answer/);
  assert.match(prompt, /new retained-turn request/);
});

test("retained continuation sends only the post-assistant delta", () => {
  const prompt = compileBrowserContinuationPrompt(context(), "turn_next");
  assert.doesNotMatch(prompt, /old user request/);
  assert.doesNotMatch(prompt, /old assistant answer/);
  assert.match(prompt, /new retained-turn request/);
  assert.match(prompt, /turn_next/);
});

test("browser turn contract requires the completed answer to remain visible in ChatGPT", () => {
  const seed = compileBrowserPrompt(context(), "turn_seed_visible");
  const continuation = compileBrowserContinuationPrompt(
    context(),
    "turn_next_visible",
  );

  for (const prompt of [seed, continuation]) {
    assert.match(
      prompt,
      /After omp_turn_complete returns success, render exactly that same answer as normal ChatGPT assistant prose/,
    );
    assert.match(prompt, /do not call any more tools/i);
  }
});
