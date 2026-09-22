import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { classifyBrowserRequest } from "./network-policy.js";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
} from "./selectors.js";

export interface ChatGptBrowserRuntimeOptions {
  profileDir?: string;
  executablePath?: string;
  cdpUrl?: string;
  navigationTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export interface ChatGptTurnRequest {
  prompt: string;
  signal?: AbortSignal;
}

export interface ChatGptTurnResult {
  text: string;
  temporaryChatUrl: string;
}

export class ChatGptAuthRequiredError extends Error {
  constructor() {
    super("ChatGPT login is required in the dedicated browser profile.");
    this.name = "ChatGptAuthRequiredError";
  }
}

function defaultProfileDir(): string {
  return path.join(os.homedir(), ".omp-chatgpt-web", "browser-profile");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectBrowserExecutable(): Promise<string> {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
          process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
          process.env["PROGRAMFILES(X86)"] &&
            path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
          process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
          process.env["PROGRAMFILES(X86)"] &&
            path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ];

  for (const candidate of candidates) {
    if (candidate && (await exists(candidate))) return candidate;
  }

  throw new Error(
    "No supported Chrome/Edge executable was found. Install Google Chrome or Microsoft Edge, or pass executablePath.",
  );
}

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT browser turn aborted", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("ChatGPT browser turn aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ChatGptBrowserRuntime {
  readonly #options: Required<
    Pick<ChatGptBrowserRuntimeOptions, "profileDir" | "navigationTimeoutMs" | "responseTimeoutMs">
  > &
    Pick<ChatGptBrowserRuntimeOptions, "executablePath" | "cdpUrl">;
  #browser?: Browser;
  #context?: BrowserContext;
  #ownsBrowser = false;

  constructor(options: ChatGptBrowserRuntimeOptions = {}) {
    this.#options = {
      profileDir: options.profileDir ?? defaultProfileDir(),
      executablePath: options.executablePath,
      cdpUrl: options.cdpUrl ?? process.env.OMP_CHATGPT_WEB_CDP_URL,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 60_000,
      responseTimeoutMs: options.responseTimeoutMs ?? 5 * 60_000,
    };
  }

  get profileDir(): string {
    return this.#options.profileDir;
  }

  get connectionMode(): "cdp" | "playwright-launch" {
    return this.#options.cdpUrl ? "cdp" : "playwright-launch";
  }

  async start(): Promise<void> {
    if (this.#context) return;

    if (this.#options.cdpUrl) {
      const browser = await chromium.connectOverCDP(this.#options.cdpUrl, {
        timeout: this.#options.navigationTimeoutMs,
        noDefaults: true,
      });
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => {});
        throw new Error("CDP browser did not expose its default browser context.");
      }
      this.#browser = browser;
      this.#context = context;
      this.#ownsBrowser = false;
    } else {
      const executablePath = this.#options.executablePath ?? (await detectBrowserExecutable());
      this.#context = await chromium.launchPersistentContext(this.#options.profileDir, {
        executablePath,
        headless: false,
        viewport: null,
        args: ["--start-maximized"],
      });
      this.#ownsBrowser = true;
    }

    const context = this.#context;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const verdict = classifyBrowserRequest(request.url(), {
        navigation: request.isNavigationRequest(),
      });
      if (!verdict.allowed) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }

  async close(): Promise<void> {
    const context = this.#context;
    const browser = this.#browser;
    const ownsBrowser = this.#ownsBrowser;

    this.#context = undefined;
    this.#browser = undefined;
    this.#ownsBrowser = false;

    if (browser) {
      await browser.close().catch(() => {});
      return;
    }

    if (ownsBrowser && context) await context.close().catch(() => {});
  }

  async openLogin(): Promise<Page> {
    const context = await this.#requireContext();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: this.#options.navigationTimeoutMs,
    });
    return page;
  }

  async waitUntilAuthenticated(timeoutMs = 10 * 60_000): Promise<void> {
    const page = await this.openLogin();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await firstVisible(page.locator(CHATGPT_COMPOSER_SELECTOR))) return;
      await delay(500);
    }
    throw new ChatGptAuthRequiredError();
  }

  async checkAuthenticated(): Promise<boolean> {
    const page = await this.openLogin();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await firstVisible(page.locator(CHATGPT_COMPOSER_SELECTOR))) return true;
      await delay(250);
    }
    return false;
  }

  async runTurn(request: ChatGptTurnRequest): Promise<ChatGptTurnResult> {
    throwIfAborted(request.signal);
    if (!request.prompt.trim()) throw new Error("ChatGPT prompt must not be empty.");

    const context = await this.#requireContext();
    const page = await context.newPage();
    try {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: this.#options.navigationTimeoutMs,
      });
      throwIfAborted(request.signal);

      const composer = await this.#waitForComposer(page, 20_000, request.signal);
      const assistantTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
      const baseline = await assistantTurns.count();

      await composer.fill(request.prompt);
      throwIfAborted(request.signal);
      await composer.press("Enter");

      const text = await this.#waitForAssistantText(page, baseline, request.signal);
      return { text, temporaryChatUrl: page.url() };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async #waitForComposer(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<Locator> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const composer = await firstVisible(page.locator(CHATGPT_COMPOSER_SELECTOR));
      if (composer) return composer;
      await delay(250, signal);
    }
    throw new ChatGptAuthRequiredError();
  }

  async #waitForAssistantText(
    page: Page,
    baselineCount: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + this.#options.responseTimeoutMs;
    let lastText = "";
    let stableSamples = 0;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const turns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
      const count = await turns.count();
      if (count > baselineCount) {
        const current = (await turns.last().innerText().catch(() => "")).trim();
        if (current) {
          stableSamples = current === lastText ? stableSamples + 1 : 0;
          lastText = current;

          const stopVisible = await firstVisible(page.locator(CHATGPT_STOP_BUTTON_SELECTOR));
          const completionVisible = await firstVisible(page.locator(CHATGPT_COMPLETION_ACTION_SELECTOR));
          if (!stopVisible && completionVisible && stableSamples >= 3) return current;
          if (!stopVisible && stableSamples >= 6) return current;
        }
      }
      await delay(300, signal);
    }

    throw new Error("Timed out waiting for ChatGPT Web to complete the assistant response.");
  }

  async #requireContext(): Promise<BrowserContext> {
    await this.start();
    if (!this.#context) throw new Error("ChatGPT browser runtime failed to start.");
    return this.#context;
  }
}
