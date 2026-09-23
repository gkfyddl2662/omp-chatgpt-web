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



test("compaction prefers retained Web history and falls back to a fresh maintenance-only Web request", () => {
  const start = providerSource.indexOf("if (isOmpCompactionContext(context, options))");
  const end = providerSource.indexOf("const expectedToolCallId", start);
  assert.ok(start >= 0 && end > start);
  const block = providerSource.slice(start, end);

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

test("replay-unsafe browser failures are marked non-retryable for OMP", () => {
  assert.match(providerSource, /ChatGptReplayUnsafeTurnError/);
  assert.match(providerSource, /AIError\.Flag\.UserInterrupt/);
  assert.doesNotMatch(
    providerSource,
    /browserMessage.*errorMessage|errorMessage.*browserMessage/,
  );
});
