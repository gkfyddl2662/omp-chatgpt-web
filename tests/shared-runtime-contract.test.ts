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

