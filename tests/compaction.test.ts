import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@oh-my-pi/pi-ai";
import {
  compileCompactionPrompt,
  compileRetainedCompactionPrompt,
  isOmpCompactionContext,
  OMP_SUMMARIZATION_SYSTEM_MARKER,
} from "../src/compaction.js";

function context(userText: string, system = OMP_SUMMARIZATION_SYSTEM_MARKER): Context {
  return {
    systemPrompt: [system],
    messages: [{
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    }],
  };
}

test("detects OMP full compaction summary requests", () => {
  assert.equal(
    isOmpCompactionContext(context(
      "<conversation>history</conversation>\n\nYou MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.",
    )),
    true,
  );
});

test("detects OMP short and turn-prefix compaction requests", () => {
  assert.equal(
    isOmpCompactionContext(context(
      "<conversation>history</conversation>\n\nSummarize conversation changes as a pull request description.",
    )),
    true,
  );
  assert.equal(
    isOmpCompactionContext(context(
      "<conversation>history</conversation>\n\nTurn prefix too large; recent-work suffix retained.",
    )),
    true,
  );
});

test("detects custom compaction instructions under the OMP summarization system", () => {
  assert.equal(
    isOmpCompactionContext(context(
      "<conversation>history</conversation>\n\nFocus only on unresolved design decisions and preserve exact paths.",
    )),
    true,
  );
});

test("detects OMP handoff compaction only when tools are disabled", () => {
  const handoff = context(
    "<critical>\nWrite a handoff document for another instance of yourself.\n" +
    "The handoff MUST be sufficient for seamless continuation without access to this conversation.\n" +
    "Output ONLY the handoff document. No preamble, no commentary, no wrapper text.\n</critical>",
    "You are the live OMP coding agent.",
  );
  assert.equal(isOmpCompactionContext(handoff, { toolChoice: "none" }), true);
  assert.equal(isOmpCompactionContext(handoff, { toolChoice: "auto" }), false);
});

test("does not classify an ordinary agent turn as compaction", () => {
  assert.equal(
    isOmpCompactionContext(context("Please fix the failing tests.", "You are an OMP coding agent.")),
    false,
  );
});

test("compaction prompt explicitly forbids tools and preserves source text", () => {
  const source = "<conversation>exact/path.ts failed with E42</conversation>\n\n" +
    "You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.";
  const prompt = compileCompactionPrompt(context(source));
  assert.match(prompt, /text-only OMP context-maintenance request/);
  assert.match(prompt, /Do not use apps, tools, web search, files, MCP, or code execution/);
  assert.match(prompt, /exact\/path\.ts failed with E42/);
  assert.match(prompt, /Return only the requested summary text/);
});


test("retained compaction uses the existing ChatGPT thread instead of replaying full history", () => {
  const source = "<conversation>very large retained history with exact/path.ts</conversation>\n\n" +
    "You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.";
  const prompt = compileRetainedCompactionPrompt(context(source));
  assert.match(prompt, /SAME ChatGPT conversation/);
  assert.match(prompt, /conversation history already present/);
  assert.doesNotMatch(prompt, /very large retained history/);
  assert.match(prompt, /Summarize that retained conversation/);
});
