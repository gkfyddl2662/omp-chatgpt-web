import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { RuntimeConfig } from "./config.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function firstVisible(locators: Locator[], timeout = 500): Promise<Locator | undefined> {
  for (const locator of locators) {
    try {
      if (await locator.first().isVisible({ timeout })) return locator.first();
    } catch {
      // Try the next known UI variant.
    }
  }
  return undefined;
}

interface BrowserTurn {
  page: Page;
  approvalTimer?: ReturnType<typeof setInterval>;
}

export class ChatGptBrowserBackend {
  #browser?: Browser;
  #context?: BrowserContext;
  readonly #turns = new Map<string, BrowserTurn>();

  async openLogin(config: RuntimeConfig): Promise<void> {
    if (!config.browserExecutable) {
      throw new Error(
        "No Chrome/Chromium executable was found. Set OMP_CHATGPT_WEB_BROWSER to the browser executable.",
      );
    }

    await mkdir(config.browserProfileDir, { recursive: true });

    const child = spawn(
      config.browserExecutable,
      [
        "--user-data-dir=" + config.browserProfileDir,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();
  }

  async #openAutomation(config: RuntimeConfig): Promise<void> {
    if (!config.browserExecutable) {
      throw new Error(
        "No Chrome/Chromium executable was found. Set OMP_CHATGPT_WEB_BROWSER to the browser executable.",
      );
    }

    await mkdir(config.browserProfileDir, { recursive: true });

    const endpoint = "http://127.0.0.1:" + config.browserCdpPort;
    if (await this.#cdpReady(endpoint)) return;

    const child = spawn(
      config.browserExecutable,
      [
        "--remote-debugging-port=" + config.browserCdpPort,
        "--user-data-dir=" + config.browserProfileDir,
        "--no-first-run",
        "--no-default-browser-check",
        "https://chatgpt.com/",
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.#cdpReady(endpoint)) return;
      await sleep(250);
    }

    throw new Error(
      "Chrome automation endpoint did not become ready on " +
        endpoint +
        ". If the manual /web-open login Chrome is still open, close that window completely and retry the model turn.",
    );
  }

  async #connect(config: RuntimeConfig): Promise<BrowserContext> {
    if (this.#browser?.isConnected() && this.#context) {
      return this.#context;
    }

    // The user may have closed the Chrome window manually while OMP still held
    // Playwright objects. Drop those stale handles before reconnecting.
    this.#browser = undefined;
    this.#context = undefined;

    await this.#openAutomation(config);

    const endpoint = "http://127.0.0.1:" + config.browserCdpPort;
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];

    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error("Connected to Chrome over CDP but no browser context was available.");
    }

    this.#browser = browser;
    this.#context = context;

    browser.once("disconnected", () => {
      if (this.#browser === browser) {
        this.#browser = undefined;
        this.#context = undefined;
      }
    });

    return context;
  }

  async #newPage(config: RuntimeConfig): Promise<Page> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const context = await this.#connect(config);
        return await context.newPage();
      } catch (error) {
        lastError = error;
        this.#browser = undefined;
        this.#context = undefined;

        if (attempt === 0) {
          await sleep(300);
          continue;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  async #cdpReady(endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(750) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async status(config?: RuntimeConfig): Promise<{ open: boolean; attached: boolean; activeTurns: number; urls: string[] }> {
    const open = config
      ? await this.#cdpReady("http://127.0.0.1:" + config.browserCdpPort)
      : Boolean(this.#context);
    return {
      open,
      attached: Boolean(this.#browser?.isConnected() && this.#context),
      activeTurns: this.#turns.size,
      urls: [...this.#turns.values()].map(turn => turn.page.url()),
    };
  }

  async startTurn(
    sessionKey: string,
    prompt: string,
    config: RuntimeConfig,
  ): Promise<void> {
    if (this.#turns.has(sessionKey)) {
      throw new Error("ChatGPT Web turn already exists for session " + sessionKey);
    }
    const page = await this.#newPage(config);
    await page.goto(config.chatUrl, { waitUntil: "domcontentloaded" });
    const composer = await this.#requireComposer(page);
    await this.#mentionConnector(page, composer, config.connectorName);

    const turn: BrowserTurn = { page };
    this.#turns.set(sessionKey, turn);
    if (config.autoApproveToolCalls) {
      turn.approvalTimer = setInterval(() => {
        void this.#approveOnce(page);
      }, 350);
      turn.approvalTimer.unref?.();
    }

    try {
      await composer.click();
      await page.keyboard.insertText(" " + prompt);
      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page);
    } catch (error) {
      await this.releaseTurn(sessionKey);
      throw error;
    }
  }

  async runTextOnly(
    prompt: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    const page = await this.#newPage(config);
    try {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Text-only Web request aborted", "AbortError");
      }
      await page.goto(config.chatUrl, { waitUntil: "domcontentloaded" });
      const composer = await this.#requireComposer(page);
      await this.#assertNoConnectorSelected(page, composer, config.connectorName);
      await composer.fill(prompt);
      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page);
      return await this.#waitForAssistantText(page, config.turnTimeoutMs, signal);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async releaseTurn(sessionKey: string): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    if (!turn) return;
    this.#turns.delete(sessionKey);
    if (turn.approvalTimer) clearInterval(turn.approvalTimer);
    try {
      await turn.page.close();
    } catch {
      // Browser cleanup is best-effort after the OMP turn has already settled.
    }
  }

  async close(): Promise<void> {
    const keys = [...this.#turns.keys()];
    await Promise.allSettled(keys.map(key => this.releaseTurn(key)));
    const browser = this.#browser;
    this.#browser = undefined;
    this.#context = undefined;
    if (browser) await browser.close();
  }

  async #composer(page: Page): Promise<Locator | undefined> {
    return firstVisible([
      page.locator("#prompt-textarea"),
      page.locator('[contenteditable="true"][data-virtualkeyboard="true"]'),
      page.locator('textarea[placeholder*="Message"]'),
    ], 700);
  }

  async #requireComposer(page: Page): Promise<Locator> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const composer = await this.#composer(page);
      if (composer) return composer;
      await sleep(300);
    }
    throw new Error(
      "ChatGPT composer was not found. Run /web-open, sign in to chatgpt.com, and verify the account can open a normal chat.",
    );
  }

  async #mentionConnector(
    page: Page,
    composer: Locator,
    connectorName: string,
  ): Promise<void> {
    await composer.click();

    // A fresh Temporary Chat should have an empty composer. Clear any stale draft
    // before inserting the app mention.
    await page.keyboard.press("Control+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);

    const mentionQuery = connectorName.trim().split(/\s+/)[0] || connectorName;
    await page.keyboard.type("@" + mentionQuery, { delay: 35 });

    const suggestion = await firstVisible([
      page.getByRole("option", { name: connectorName, exact: true }),
      page.getByRole("menuitem", { name: connectorName, exact: true }),
      page.getByRole("button", { name: connectorName, exact: true }),
      page.getByText(connectorName, { exact: true }),
    ], 2_000);

    if (suggestion) {
      await suggestion.click();
    } else {
      // Current ChatGPT builds can highlight the best @mention suggestion
      // without exposing a stable option/menuitem node. Match the manual UX:
      // type "@OMP", then press Enter to accept the highlighted app.
      await page.keyboard.press("Enter");
    }
    await sleep(300);

    // The app mention usually becomes a structured chip/token inside or adjacent
    // to the composer. Verify visible evidence without rewriting the composer.
    const composerContainer = composer.locator(
      "xpath=ancestor::*[self::form or @data-type='unified-composer'][1]",
    );
    const mentioned = await firstVisible([
      composerContainer.getByText(connectorName, { exact: true }),
      page.locator('[data-mention], [data-app-id], [data-testid*="mention"]').filter({
        hasText: connectorName,
      }),
    ], 1_000);

    if (!mentioned) {
      // Some ChatGPT surfaces don't expose the mention chip to accessibility
      // selectors. The suggestion click itself is still stronger evidence than
      // the old '+' menu path, so only fail if the literal query remains in the
      // composer as plain text.
      const currentText = (await composer.innerText().catch(() => "")).trim();
      const currentValue = (await composer.inputValue().catch(() => "")).trim();
      const plain = currentText || currentValue;
      if (plain === "@" + mentionQuery) {
        throw new Error(
          'ChatGPT app "' +
            connectorName +
            '" suggestion was clicked but the mention did not attach to the composer.',
        );
      }
    }
  }

  async #assertNoConnectorSelected(
    page: Page,
    composer: Locator,
    connectorName: string,
  ): Promise<void> {
    const selected = page
      .locator('[aria-pressed="true"], [data-state="checked"], [data-state="on"]')
      .filter({ hasText: connectorName });
    const container = composer.locator(
      "xpath=ancestor::*[self::form or @data-type='unified-composer'][1]",
    );
    const nearComposer = container.getByText(connectorName, { exact: true });
    const attached = await firstVisible([selected, nearComposer], 100);
    if (attached) {
      throw new Error(
        'Text-only compaction requires a fresh ChatGPT chat with no "' +
          connectorName +
          '" connector attached.',
      );
    }
  }

  async #waitForSubmissionEvidence(page: Page): Promise<void> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const userTurns = page.locator('[data-message-author-role="user"]');
      if ((await userTurns.count().catch(() => 0)) > 0) return;
      const stop = await firstVisible([
        page.locator('button[data-testid="stop-button"]'),
        page.getByRole("button", { name: /Stop streaming|Stop generating/i }),
        page.getByRole("button", { name: /생성 중지|응답 중지/ }),
      ]);
      if (stop) return;
      await sleep(250);
    }
    throw new Error("ChatGPT Web did not show evidence that the OMP provider prompt was submitted.");
  }

  async #waitForAssistantText(
    page: Page,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let stableSince = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Text-only Web request aborted", "AbortError");
      }

      const assistantTurns = page.locator('[data-message-author-role="assistant"]');
      const count = await assistantTurns.count().catch(() => 0);
      if (count > 0) {
        const text = (await assistantTurns.nth(count - 1).innerText().catch(() => "")).trim();
        if (text && text === lastText) {
          if (!stableSince) stableSince = Date.now();
        } else if (text) {
          lastText = text;
          stableSince = Date.now();
        }
      }

      const stop = await firstVisible([
        page.locator('button[data-testid="stop-button"]'),
        page.getByRole("button", { name: /Stop streaming|Stop generating/i }),
        page.getByRole("button", { name: /생성 중지|응답 중지/ }),
      ], 100);

      if (lastText && stableSince && Date.now() - stableSince >= 1_500 && !stop) {
        return lastText;
      }
      await sleep(250);
    }

    throw new Error("ChatGPT Web text-only request timed out after " + timeoutMs + "ms.");
  }

  async #approveOnce(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const allow = await firstVisible([
      page.getByRole("button", { name: /Allow once/i }),
      page.getByRole("button", { name: /한 번 허용/ }),
    ], 100);
    if (allow) await allow.click().catch(() => undefined);
  }
}
