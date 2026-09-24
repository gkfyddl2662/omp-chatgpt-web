import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionSource = readFileSync(
  new URL("../extensions/chatgpt-web/index.ts", import.meta.url),
  "utf8",
);
const browserSource = readFileSync(
  new URL("../src/browser-backend.ts", import.meta.url),
  "utf8",
);
const providerSource = readFileSync(
  new URL("../src/provider.ts", import.meta.url),
  "utf8",
);

test("parent and subagent sessions share one module-level Web runtime", () => {
  assert.match(
    extensionSource,
    /const sharedBroker = new TurnBroker\(\{ schemaForTool: toolWireSchema \}\)/,
  );
  assert.match(
    extensionSource,
    /const sharedBrowser = new ChatGptBrowserBackend\(\)/,
  );
  assert.match(extensionSource, /const sharedTunnel = new TunnelSupervisor\(\)/);
  assert.match(extensionSource, /let sharedMcp:/);

  const factoryStart = extensionSource.indexOf(
    "export default function chatGptWebExtension",
  );
  assert.ok(factoryStart >= 0);
  const factory = extensionSource.slice(factoryStart);

  assert.doesNotMatch(factory, /const broker = new TurnBroker/);
  assert.doesNotMatch(factory, /const browser = new ChatGptBrowserBackend\(\)/);
  assert.doesNotMatch(factory, /const tunnel = new TunnelSupervisor\(\)/);
});

test("Web parent routes task and eval subagents back through chatgpt-web/web", () => {
  assert.match(extensionSource, /pi\.on\("before_subagent_spawn"/);
  assert.match(
    extensionSource,
    /current\?\.provider !== PROVIDER \|\| current\.id !== MODEL/,
  );
  assert.match(extensionSource, /model: PROVIDER \+ "\/" \+ MODEL/);
});

test("shared MCP and tunnel starts are serialized", () => {
  assert.match(extensionSource, /sharedMcpStarting/);
  assert.match(extensionSource, /sharedTunnelStarting/);
  assert.match(extensionSource, /if \(!sharedMcpStarting\)/);
  assert.match(extensionSource, /if \(!sharedTunnelStarting\)/);
});

test("shared browser startup is serialized and retained work stays on Temporary Chat", () => {
  assert.match(browserSource, /#connecting\?: Promise<BrowserContext>/);
  assert.match(
    browserSource,
    /if \(this\.#connecting\) return await this\.#connecting/,
  );
  assert.doesNotMatch(browserSource, /#rehydrateRetainedPage/);
  assert.doesNotMatch(browserSource, /#canRehydrateRetainedPage/);
});

test("connector selection fails closed unless the exact OMP app pill is attached", () => {
  assert.match(
    browserSource,
    /locator\('\[data-id\^="plugin:"\]\[data-keyword\]'\)/,
  );
  assert.match(browserSource, /keyword === connectorName/);
  assert.match(browserSource, /getAttribute\("data-highlighted"\)/);
  assert.match(browserSource, /did not attach the exact connector/);
});

test("completed Web turns remain owned until the browser physically settles", () => {
  assert.match(browserSource, /settling\?: Promise<void>/);
  assert.match(browserSource, /this\.#waitUntilIdle\(/);
  assert.match(
    browserSource,
    /ChatGPT turn did not physically settle within/,
  );
  assert.match(
    browserSource,
    /await this\.waitForTurnIdle\(sessionKey\)/,
  );
});

test("backend automation stays CDP-only without foreground or clipboard injection", () => {
  assert.doesNotMatch(browserSource, /SetForegroundWindow/);
  assert.doesNotMatch(browserSource, /SendKeys/);
  assert.doesNotMatch(browserSource, /navigator\.clipboard/);
  assert.doesNotMatch(browserSource, /ClipboardEvent/);
  assert.doesNotMatch(browserSource, /bringToFront\(/);
});

test("obsolete retained-session experiment state is absent", () => {
  assert.doesNotMatch(browserSource, /resetAfterTurn/);
  assert.doesNotMatch(browserSource, /lastUsedAt/);
  assert.doesNotMatch(browserSource, /markResetAfterTurn/);
});



test("provider distinguishes handoff from structured maintenance before choosing fresh fallback", () => {
  const start = providerSource.indexOf("const compactionKind = classifyOmpCompactionContext(");
  const end = providerSource.indexOf("const expectedToolCallId", start);
  assert.ok(start >= 0 && end > start);
  const block = providerSource.slice(start, end);

  assert.match(block, /compactionKind === "structured"/);
  assert.match(block, /compileRetainedCompactionPrompt/);
  assert.match(block, /compileCompactionPrompt/);
  assert.match(block, /compactSessionWhenIdle/);
  assert.doesNotMatch(block, /compileBrowserPrompt\(/);
  assert.doesNotMatch(block, /broker\.begin\(/);
});

test("fresh context-full maintenance uses plain ChatGPT without OMP Local and resets before the next agent epoch", () => {
  const routeStart = browserSource.indexOf("async compactSessionWhenIdle(");
  const routeEnd = browserSource.indexOf("async compactRetainedSessionWhenIdle(", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = browserSource.slice(routeStart, routeEnd);

  assert.match(route, /hasRetainedConversation\(sessionKey\)/);
  assert.match(route, /compactRetainedSession/);
  assert.match(route, /compactFreshSession/);

  const freshStart = browserSource.indexOf("async compactFreshSession(");
  const freshEnd = browserSource.indexOf("async invalidateSession(", freshStart);
  assert.ok(freshStart >= 0 && freshEnd > freshStart);
  const fresh = browserSource.slice(freshStart, freshEnd);

  assert.match(fresh, /#prepareCompactionComposer/);
  assert.match(fresh, /kind: "fresh-compaction"/);
  assert.match(fresh, /#waitForAssistantText/);
  assert.match(fresh, /#resetSessionPage/);
  assert.doesNotMatch(fresh, /#mentionConnector/);
  assert.doesNotMatch(fresh, /OMP Local/);
});

test("compaction watches ChatGPT error UI before accepting assistant text", () => {
  assert.match(browserSource, /#chatErrorState/);
  assert.match(browserSource, /Something went wrong/);
  assert.match(browserSource, /Retry\|Try again\|다시 시도/);
  assert.match(browserSource, /assertValidCompactionSummary/);
});


test("ordinary Web turns detect ChatGPT timeout UI without clicking browser Retry", () => {
  assert.match(browserSource, /메시지 전송 시간이 초과되었습니다/);
  assert.match(browserSource, /waitForTurnFailure/);
  assert.match(providerSource, /Promise\.race\(\[/);
  assert.match(providerSource, /waitForTurnFailure\(conversation, failureSignal\)/);

  const start = browserSource.indexOf("async waitForTurnFailure(");
  const end = browserSource.indexOf("async status(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /ChatGptReplayUnsafeTurnError/);
  assert.doesNotMatch(block, /\.retry\.click\(/);
});

test("replay-unsafe browser failures are silent and non-retryable for OMP", () => {
  assert.match(providerSource, /ChatGptReplayUnsafeTurnError/);
  assert.match(providerSource, /AIError\.Flag\.SilentAbort/);
  assert.doesNotMatch(providerSource, /AIError\.Flag\.UserInterrupt/);
  assert.doesNotMatch(
    providerSource,
    /browserMessage.*errorMessage|errorMessage.*browserMessage/,
  );
});

test("browser timeout releases only turn ownership and preserves retained history for COMPACT", () => {
  assert.match(providerSource, /releaseReplayUnsafeTurnForMaintenance\(conversation\)/);

  const start = browserSource.indexOf("async releaseReplayUnsafeTurnForMaintenance(");
  const end = browserSource.indexOf("async invalidateSession(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /this\.#turns\.delete\(sessionKey\)/);
  assert.match(block, /return true/);
  assert.doesNotMatch(block, /#releasePageWithoutStoppingBrowser/);
  assert.doesNotMatch(block, /page\.goto\(/);
});

test("handoff stays retained-only while structured maintenance may retry fresh", () => {
  const start = browserSource.indexOf("async compactSessionWhenIdle(");
  const end = browserSource.indexOf("async compactRetainedSessionWhenIdle(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /prompts\.kind === "handoff"/);
  assert.match(block, /throw error/);
  assert.match(block, /fresh full-history handoff replay is disabled/);
  assert.match(block, /compactFreshSession/);
  assert.match(block, /if \(signal\?\.aborted\) throw error/);
});

test("maintenance submission falls back from Enter to the ChatGPT Send button", () => {
  const start = browserSource.indexOf("async #submitComposerPrompt(");
  const end = browserSource.indexOf("async #prepareCompactionComposer(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /composer\.press\("Enter"\)/);
  assert.match(block, /#sendButton\(page\)/);
  assert.match(block, /send\.click\(\)/);
  assert.match(block, /#waitForSubmissionEvidenceFor/);
  assert.match(browserSource, /button\[data-testid="send-button"\]/);
});

test("definitely unsubmitted retained maintenance preserves the retained thread", () => {
  const start = browserSource.indexOf("async compactRetainedSession(");
  const end = browserSource.indexOf("async compactFreshSession(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /ChatGptPromptNotSubmittedError/);
  const catchStart = block.indexOf("} catch (error) {");
  assert.ok(catchStart >= 0);
  const catchBlock = block.slice(catchStart);
  assert.match(catchBlock, /instanceof ChatGptPromptNotSubmittedError/);
  assert.match(catchBlock, /throw error/);
  assert.match(catchBlock, /invalidateSession\(sessionKey\)/);
});


test("ordinary Web turns use Enter then guarded Send fallback before invalidating", () => {
  const start = browserSource.indexOf("async startTurn(");
  const end = browserSource.indexOf("async finishTurn(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /#submitComposerPrompt\(/);
  assert.match(block, /beforeFallbackSend/);
  assert.match(block, /#selectedConnectorIsExact/);
  assert.match(block, /ChatGptPromptNotSubmittedError/);
  assert.match(block, /#recoverUnsubmittedTurn/);
  assert.match(block, /invalidateSession\(sessionKey\)/);
  assert.doesNotMatch(block, /#waitForSubmissionEvidence\(page, baselineUsers\)/);
});

test("definite ordinary submission misses are silent recoveries for active Goals", () => {
  assert.match(providerSource, /ChatGptPromptNotSubmittedError/);
  assert.match(
    providerSource,
    /error instanceof ChatGptReplayUnsafeTurnError[\s\S]*error instanceof ChatGptPromptNotSubmittedError/,
  );
  assert.match(providerSource, /AIError\.Flag\.SilentAbort/);
});

test("shared composer submit helper clicks Send only after Enter leaves a verified draft", () => {
  const start = browserSource.indexOf("async #submitComposerPrompt(");
  const end = browserSource.indexOf("async #prepareCompactionComposer(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  const enter = block.indexOf('composer.press("Enter")');
  const draft = block.indexOf("draftStillPresent");
  const send = block.indexOf("send.click()");
  assert.ok(enter >= 0 && draft > enter && send > draft);
  assert.match(block, /beforeFallbackSend/);
  assert.match(block, /#clearUnsubmittedPromptDraft/);
});


test("connector readiness retries capability probes for up to 180 seconds", () => {
  const start = browserSource.indexOf("async #mentionConnector(");
  const end = browserSource.indexOf("async #composerContainsPrompt(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  assert.match(block, /readinessDeadline = Date\.now\(\) \+ 180_000/);
  assert.match(block, /probeWindowMs = 2_000/);
  assert.match(block, /retryDelayMs = 400/);
  assert.match(block, /attachWindowMs = 10_000/);
  assert.match(block, /await activeComposer\.fill\(mentionText\)/);
  assert.match(block, /await activeComposer\.fill\(""\)/);
  assert.match(block, /activeComposer = await this\.#requireComposer\(page\)/);
  assert.match(block, /within 180 seconds/);
  assert.doesNotMatch(block, /Date\.now\(\) \+ 12_000/);
});

test("connector readiness never clears a connector that attached late", () => {
  const start = browserSource.indexOf("async #mentionConnector(");
  const end = browserSource.indexOf("async #composerContainsPrompt(", start);
  assert.ok(start >= 0 && end > start);
  const block = browserSource.slice(start, end);

  const lateAttachComment = block.indexOf("selection did not stick");
  const lateExactCheck = block.indexOf(
    "await this.#selectedConnectorIsExact(",
    lateAttachComment,
  );
  const nextClear = block.indexOf(
    'await activeComposer.fill("").catch(() => undefined)',
    lateAttachComment,
  );
  assert.ok(lateAttachComment >= 0);
  assert.ok(lateExactCheck > lateAttachComment);
  assert.ok(nextClear > lateExactCheck);
});
