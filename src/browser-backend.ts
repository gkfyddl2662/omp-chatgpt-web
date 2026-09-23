import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
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
  #context?: BrowserContext;
  readonly #turns = new Map<string, BrowserTurn>();

  async open(config: RuntimeConfig): Promise<Page> {
    if (!config.browserExecutable) {
      throw new Error(
        "No Chrome/Chromium executable was found. Set OMP_CHATGPT_WEB_BROWSER to the browser executable.",
      );
    }
    if (!this.#context) {
      await mkdir(config.browserProfileDir, { recursive: true });
      this.#context = await chromium.launchPersistentContext(config.browserProfileDir, {
        executablePath: config.browserExecutable,
        headless: !config.headed,
        viewport: { width: 1440, height: 1000 },
        args: ["--disable-background-timer-throttling"],
      });
    }
    const page = this.#context.pages()[0] ?? await this.#context.newPage();
    if (!page.url().startsWith("https://chatgpt.com/")) {
      await page.goto(config.chatUrl, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront();
    return page;
  }

  async status(): Promise<{ open: boolean; activeTurns: number; urls: string[] }> {
    return {
      open: Boolean(this.#context),
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
    const anchor = await this.open(config);
    const page = this.#turns.size === 0 && anchor.url().startsWith("https://chatgpt.com/")
      ? anchor
      : await this.#context!.newPage();

    await page.goto(config.chatUrl, { waitUntil: "domcontentloaded" });
    let composer = await this.#requireComposer(page);
    composer = await this.#selectConnector(page, config.connectorName);

    const turn: BrowserTurn = { page };
    this.#turns.set(sessionKey, turn);
    if (config.autoApproveToolCalls) {
      turn.approvalTimer = setInterval(() => {
        void this.#approveOnce(page);
      }, 350);
      turn.approvalTimer.unref?.();
    }

    try {
      await composer.fill(prompt);
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
    await this.open(config);
    const page = await this.#context!.newPage();
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
    const context = this.#context;
    this.#context = undefined;
    if (context) await context.close();
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

  async #selectConnector(page: Page, connectorName: string): Promise<Locator> {
    const toolsButton = await firstVisible([
      page.getByRole("button", { name: /^Tools$/i }),
      page.getByRole("button", { name: /^Apps$/i }),
      page.getByRole("button", { name: /도구/ }),
      page.getByRole("button", { name: /앱/ }),
      page.locator('button[data-testid="composer-plus-btn"]'),
    ], 1_000);
    if (!toolsButton) {
      throw new Error(
        "ChatGPT Tools/Apps control was not found. Refusing to send an unbound Web-model turn.",
      );
    }

    await toolsButton.click();
    const connector = page.getByText(connectorName, { exact: true });
    try {
      await connector.first().waitFor({ state: "visible", timeout: 7_000 });
    } catch {
      throw new Error(
        'ChatGPT connector "' + connectorName + '" was not found. Create/enable that Tunnel-backed connector first.',
      );
    }
    await connector.first().click();
    await page.keyboard.press("Escape").catch(() => undefined);

    const activeComposer = await this.#requireComposer(page);
    const selected = page
      .locator('[aria-pressed="true"], [data-state="checked"], [data-state="on"]')
      .filter({ hasText: connectorName });
    const composerContainer = activeComposer.locator(
      "xpath=ancestor::*[self::form or @data-type='unified-composer'][1]",
    );
    const nearComposer = composerContainer.getByText(connectorName, { exact: true });
    const verified =
      (await selected.count().catch(() => 0)) > 0 ||
      (await nearComposer.count().catch(() => 0)) > 0;

    if (!verified) {
      throw new Error(
        'Connector "' + connectorName + '" was clicked but selected state could not be verified. Refusing to consume a Web-model turn without MCP.',
      );
    }
    return activeComposer;
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
