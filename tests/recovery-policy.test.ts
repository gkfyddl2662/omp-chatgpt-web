import assert from "node:assert/strict";
import test from "node:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { ChatGptReplayUnsafeTurnError } from "../src/browser-backend.js";

test("replay-unsafe browser failures use a retry-neutral public message", () => {
  const error = new ChatGptReplayUnsafeTurnError(
    "메시지 전송 시간이 초과되었습니다. 다시 시도해 주세요.",
  );

  assert.match(error.message, /Automatic replay was suppressed/);
  assert.doesNotMatch(error.message, /timeout|timed out|retry|다시 시도/i);
  assert.match(error.browserMessage, /메시지 전송 시간이 초과되었습니다/);
});

test("OMP UserInterrupt classification is not automatically retriable", () => {
  const errorId = AIError.create(AIError.Flag.UserInterrupt);
  assert.equal(AIError.retriable(errorId), false);
  assert.equal(AIError.is(errorId, AIError.Flag.UserInterrupt), true);
});
