import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import type { RuntimeConfig } from "./config.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function firstVisible(
  locators: Locator[],
  timeout = 500,
): Promise<Locator | undefined> {
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

interface BrowserSession {
  page: Page;
  seeded: boolean;
  resetAfterTurn: boolean;
  lastUsedAt: number;
}

interface BrowserPreparationTiming {
  promptChars: number;
  sessionMs: number;
  mentionMs: number;
  insertMs: number;
  submitMs: number;
}

export class ChatGptBrowserBackend {
  #browser?: Browser;
  #context?: BrowserContext;
  readonly #turns = new Map<string, BrowserTurn>();
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #reservedPages = new Set<Page>();
  readonly #compactionBarriers = new Map<string, Promise<void>>();
  #lastPreparation?: BrowserPreparationTiming;

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
        "--disable-background-mode",
        "https://chatgpt.com/",
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
        "--disable-background-mode",
        "about:blank",
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

    this.#browser = undefined;
    this.#context = undefined;
    this.#pruneClosedSessions();

    await this.#openAutomation(config);

    const endpoint = "http://127.0.0.1:" + config.browserCdpPort;
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];

    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error(
        "Connected to Chrome over CDP but no browser context was available.",
      );
    }

    this.#browser = browser;
    this.#context = context;

    browser.once("disconnected", () => {
      if (this.#browser !== browser) return;
      this.#browser = undefined;
      this.#context = undefined;
      this.#turns.clear();
      this.#sessions.clear();
      this.#reservedPages.clear();
      this.#compactionBarriers.clear();
    });

    return context;
  }

  #pruneClosedSessions(): void {
    for (const page of this.#reservedPages) {
      if (page.isClosed()) this.#reservedPages.delete(page);
    }
    for (const [key, session] of this.#sessions) {
      if (session.page.isClosed()) this.#sessions.delete(key);
    }
    for (const [key, turn] of this.#turns) {
      if (turn.page.isClosed()) {
        if (turn.approvalTimer) clearInterval(turn.approvalTimer);
        this.#turns.delete(key);
      }
    }
  }

  async #acquireUnownedPage(config: RuntimeConfig): Promise<Page> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const context = await this.#connect(config);
        this.#pruneClosedSessions();

        const ownedPages = new Set([
          ...[...this.#sessions.values()]
            .map(session => session.page)
            .filter(page => !page.isClosed()),
          ...[...this.#reservedPages].filter(page => !page.isClosed()),
        ]);
        const idlePages = context.pages().filter(
          page => !page.isClosed() && !ownedPages.has(page),
        );

        const reusable = idlePages[0];
        if (reusable) {
          this.#reservedPages.add(reusable);
          await Promise.allSettled(idlePages.slice(1).map(page => page.close()));
          return reusable;
        }

        const created = await context.newPage();
        this.#reservedPages.add(created);
        return created;
      } catch (error) {
        lastError = error;
        this.#browser = undefined;
        this.#context = undefined;
        this.#pruneClosedSessions();
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

  async #navigateFreshChat(page: Page, config: RuntimeConfig): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(config.chatUrl, { waitUntil: "domcontentloaded" });
        await this.#requireComposer(page);
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryable =
          /ERR_ABORTED|Target page, context or browser has been closed|has been closed/i.test(
            message,
          );
        if (!retryable || attempt > 0 || page.isClosed()) throw error;
        await sleep(350);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  async #newSessionPage(config: RuntimeConfig): Promise<Page> {
    const page = await this.#acquireUnownedPage(config);
    try {
      await this.#navigateFreshChat(page, config);
      return page;
    } catch (error) {
      this.#reservedPages.delete(page);
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  async #session(
    sessionKey: string,
    config: RuntimeConfig,
  ): Promise<BrowserSession> {
    const existing = this.#sessions.get(sessionKey);
    if (
      existing &&
      !existing.page.isClosed() &&
      this.#browser?.isConnected()
    ) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    if (existing) this.#sessions.delete(sessionKey);
    const page = await this.#newSessionPage(config);
    const session: BrowserSession = {
      page,
      seeded: false,
      resetAfterTurn: false,
      lastUsedAt: Date.now(),
    };
    this.#sessions.set(sessionKey, session);
    this.#reservedPages.delete(page);
    return session;
  }

  async #cdpReady(endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(endpoint + "/json/version", {
        signal: AbortSignal.timeout(750),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  hasRetainedConversation(sessionKey: string): boolean {
    const session = this.#sessions.get(sessionKey);
    return Boolean(
      session &&
        session.seeded &&
        !session.resetAfterTurn &&
        !session.page.isClosed() &&
        this.#browser?.isConnected(),
    );
  }

  hasSession(sessionKey: string): boolean {
    const session = this.#sessions.get(sessionKey);
    return Boolean(session && !session.page.isClosed());
  }

  isTurnActive(sessionKey: string): boolean {
    return this.#turns.has(sessionKey);
  }

  async status(config?: RuntimeConfig): Promise<{
    open: boolean;
    attached: boolean;
    tabs: number;
    retainedSessions: number;
    activeTurns: number;
    pendingCompactions: number;
    lastPreparation?: BrowserPreparationTiming;
    urls: string[];
  }> {
    this.#pruneClosedSessions();
    const open = config
      ? await this.#cdpReady("http://127.0.0.1:" + config.browserCdpPort)
      : Boolean(this.#context);
    return {
      open,
      attached: Boolean(this.#browser?.isConnected() && this.#context),
      tabs: this.#context?.pages().filter(page => !page.isClosed()).length ?? 0,
      retainedSessions: this.#sessions.size,
      activeTurns: this.#turns.size,
      pendingCompactions: this.#compactionBarriers.size,
      ...(this.#lastPreparation ? { lastPreparation: { ...this.#lastPreparation } } : {}),
      urls: [...this.#sessions.values()]
        .filter(session => !session.page.isClosed())
        .map(session => session.page.url()),
    };
  }

  async #waitForCompactionBarrier(
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const barrier = this.#compactionBarriers.get(sessionKey);
    if (!barrier) return;
    if (!signal) {
      await barrier;
      return;
    }
    if (signal.aborted) {
      throw signal.reason ??
        new DOMException("ChatGPT compaction barrier wait aborted", "AbortError");
    }
    await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(
          signal.reason ??
            new DOMException("ChatGPT compaction barrier wait aborted", "AbortError"),
        );
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  }

  async startTurn(
    sessionKey: string,
    prompt: string,
    config: RuntimeConfig,
  ): Promise<void> {
    await this.#waitForCompactionBarrier(sessionKey);

    if (this.#turns.has(sessionKey)) {
      throw new Error(
        "ChatGPT Web turn already exists for session " + sessionKey,
      );
    }

    const preparationStartedAt = Date.now();
    const session = await this.#session(sessionKey, config);
    if (session.resetAfterTurn) {
      await this.#resetSessionPage(sessionKey, config);
    }
    const sessionReadyAt = Date.now();

    const page = session.page;
    let composer: Locator;
    try {
      composer = await this.#requireComposer(page);
      await this.#mentionConnector(page, composer, config.connectorName);
    } catch (error) {
      await this.invalidateSession(sessionKey);
      throw error;
    }
    const mentionReadyAt = Date.now();

    const turn: BrowserTurn = { page };
    this.#turns.set(sessionKey, turn);

    if (config.autoApproveToolCalls) {
      turn.approvalTimer = setInterval(() => {
        void this.#approveOnce(page);
      }, 350);
      turn.approvalTimer.unref?.();
    }

    const baselineUsers = await page
      .locator('[data-message-author-role="user"]')
      .count()
      .catch(() => 0);

    try {
      await this.#insertComposerText(page, composer, " " + prompt);
      const insertedAt = Date.now();
      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page, baselineUsers);
      const submittedAt = Date.now();
      this.#lastPreparation = {
        promptChars: prompt.length,
        sessionMs: sessionReadyAt - preparationStartedAt,
        mentionMs: mentionReadyAt - sessionReadyAt,
        insertMs: insertedAt - mentionReadyAt,
        submitMs: submittedAt - insertedAt,
      };
      session.seeded = true;
      session.lastUsedAt = Date.now();
    } catch (error) {
      await this.invalidateSession(sessionKey);
      throw error;
    }
  }

  async finishTurn(
    sessionKey: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    const session = this.#sessions.get(sessionKey);

    if (turn && !turn.page.isClosed()) {
      await this.#waitUntilIdle(turn.page, Math.min(config.turnTimeoutMs, 15_000), signal)
        .catch(() => undefined);
    }

    if (turn?.approvalTimer) clearInterval(turn.approvalTimer);
    this.#turns.delete(sessionKey);

    if (session) {
      session.lastUsedAt = Date.now();
      if (session.resetAfterTurn) {
        await this.#resetSessionPage(sessionKey, config);
      }
    }
  }

  async markResetAfterTurn(sessionKey: string): Promise<void> {
    const session = this.#sessions.get(sessionKey);
    if (session) session.resetAfterTurn = true;
  }

  async resetSession(
    sessionKey: string,
    config: RuntimeConfig,
  ): Promise<void> {
    if (this.#turns.has(sessionKey)) {
      const session = this.#sessions.get(sessionKey);
      if (session) session.resetAfterTurn = true;
      return;
    }
    await this.#resetSessionPage(sessionKey, config);
  }

  async #resetSessionPage(
    sessionKey: string,
    config: RuntimeConfig,
  ): Promise<void> {
    const session = this.#sessions.get(sessionKey);
    if (!session) return;

    if (session.page.isClosed() || !this.#browser?.isConnected()) {
      this.#sessions.delete(sessionKey);
      return;
    }

    try {
      await this.#navigateFreshChat(session.page, config);
      session.seeded = false;
      session.resetAfterTurn = false;
      session.lastUsedAt = Date.now();
    } catch {
      await this.invalidateSession(sessionKey);
    }
  }

  async compactRetainedSessionWhenIdle(
    sessionKey: string,
    prompt: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    const previous = this.#compactionBarriers.get(sessionKey);
    if (previous) await previous;

    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    this.#compactionBarriers.set(sessionKey, barrier);

    try {
      await this.waitForTurnIdle(sessionKey, signal);
      return await this.compactRetainedSession(
        sessionKey,
        prompt,
        config,
        signal,
      );
    } finally {
      release();
      if (this.#compactionBarriers.get(sessionKey) === barrier) {
        this.#compactionBarriers.delete(sessionKey);
      }
    }
  }

  async waitForTurnIdle(
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    while (this.#turns.has(sessionKey)) {
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException("Retained ChatGPT turn wait aborted", "AbortError");
      }
      await sleep(100);
    }
  }

  async compactRetainedSession(
    sessionKey: string,
    prompt: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.#turns.has(sessionKey)) {
      throw new Error(
        "Cannot submit retained compaction while the ChatGPT turn is still active.",
      );
    }

    const session = this.#sessions.get(sessionKey);
    if (
      !session ||
      !session.seeded ||
      session.page.isClosed() ||
      !this.#browser?.isConnected()
    ) {
      throw new Error(
        "No retained ChatGPT conversation is available for compaction.",
      );
    }

    const page = session.page;
    const composer = await this.#requireComposer(page);
    const baselineAssistants = await page
      .locator('[data-message-author-role="assistant"]')
      .count()
      .catch(() => 0);
    const baselineUsers = await page
      .locator('[data-message-author-role="user"]')
      .count()
      .catch(() => 0);

    try {
      await composer.fill(prompt);
      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page, baselineUsers);
      const summary = await this.#waitForAssistantText(
        page,
        config.turnTimeoutMs,
        signal,
        baselineAssistants,
      );

      // Match codex-chatgpt-web retained compaction semantics: the compact
      // response comes from the retained conversation, then that SAME tab is
      // reset to a fresh chat. The next ordinary OMP turn seeds the compacted
      // OMP context into this fresh conversation.
      await this.#resetSessionPage(sessionKey, config);
      return summary;
    } catch (error) {
      await this.invalidateSession(sessionKey);
      throw error;
    }
  }

  async runTextOnly(
    prompt: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    const page = await this.#acquireUnownedPage(config);
    try {
      await this.#navigateFreshChat(page, config);
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException("Text-only Web request aborted", "AbortError");
      }

      const composer = await this.#requireComposer(page);
      const baselineAssistants = await page
        .locator('[data-message-author-role="assistant"]')
        .count()
        .catch(() => 0);
      const baselineUsers = await page
        .locator('[data-message-author-role="user"]')
        .count()
        .catch(() => 0);

      await this.#assertNoConnectorSelected(
        page,
        composer,
        config.connectorName,
      );
      await composer.fill(prompt);
      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page, baselineUsers);
      return await this.#waitForAssistantText(
        page,
        config.turnTimeoutMs,
        signal,
        baselineAssistants,
      );
    } finally {
      this.#reservedPages.delete(page);
      await page.close().catch(() => undefined);
    }
  }

  async releaseTurn(sessionKey: string): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    if (!turn) return;
    this.#turns.delete(sessionKey);
    if (turn.approvalTimer) clearInterval(turn.approvalTimer);
  }

  async invalidateSession(sessionKey: string): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    if (turn?.approvalTimer) clearInterval(turn.approvalTimer);
    this.#turns.delete(sessionKey);

    const session = this.#sessions.get(sessionKey);
    this.#sessions.delete(sessionKey);
    if (session && !session.page.isClosed()) {
      await session.page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const turn of this.#turns.values()) {
      if (turn.approvalTimer) clearInterval(turn.approvalTimer);
    }
    this.#turns.clear();
    this.#sessions.clear();
    this.#reservedPages.clear();
    this.#compactionBarriers.clear();

    const browser = this.#browser;
    this.#browser = undefined;
    this.#context = undefined;
    if (browser) await browser.close();
  }

  async #composer(page: Page): Promise<Locator | undefined> {
    return firstVisible(
      [
        page.locator("#prompt-textarea"),
        page.locator(
          '[contenteditable="true"][data-virtualkeyboard="true"]',
        ),
        page.locator('textarea[placeholder*="Message"]'),
      ],
      700,
    );
  }

  async #requireComposer(page: Page): Promise<Locator> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error("ChatGPT tab was closed.");
      }
      const composer = await this.#composer(page);
      if (composer) return composer;
      await sleep(300);
    }
    throw new Error(
      "ChatGPT composer was not found. Run /web-open, sign in to chatgpt.com, and verify the account can open a normal chat.",
    );
  }

  async #composerPlainText(composer: Locator): Promise<string> {
    const value = await composer.inputValue().catch(() => undefined);
    if (typeof value === "string") return value;
    return await composer.innerText().catch(() => "");
  }

  async #insertComposerText(
    _page: Page,
    composer: Locator,
    text: string,
  ): Promise<void> {
    await composer.focus();
    const before = await this.#composerPlainText(composer);

    // One browser editing operation, with no manually-dispatched InputEvent.
    // ChatGPT/Lexical receives the same prompt string unchanged.
    const inserted = await composer.evaluate((element, value) => {
      const el = element as HTMLElement;
      el.focus();

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      return document.execCommand("insertText", false, String(value));
    }, text).catch(() => false);

    if (!inserted) {
      // execCommand reported that it performed no edit, so a native CDP
      // insertion is still safe here: there is nothing to duplicate.
      await composer.focus();
      await _page.keyboard.insertText(text);
    }

    const actual = await this.#composerPlainText(composer);

    // ChatGPT/Lexical rewrites presentation whitespace (newlines, NBSPs and
    // paragraph boundaries) even when the submitted text is semantically the
    // same. Verify content after whitespace normalization, while keeping the
    // actual prompt string completely unchanged.
    const normalizeForVerification = (value: string): string =>
      value
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .replace(/\s+/g, " ")
        .trim();

    const normalizedPrompt = normalizeForVerification(text);
    const normalizedActual = normalizeForVerification(actual);
    const normalizedFingerprintSize = Math.min(
      2_048,
      normalizedPrompt.length,
    );
    const normalizedTail = normalizedPrompt.slice(
      -normalizedFingerprintSize,
    );

    const growth = actual.length - before.length;
    const minGrowth = Math.floor(text.length * 0.9);
    const maxGrowth = Math.ceil(text.length * 1.2) + 8_192;
    const suspiciousGrowth = growth < minGrowth || growth > maxGrowth;
    const missingTail =
      normalizedTail.length > 0 &&
      !normalizedActual.includes(normalizedTail);

    if (suspiciousGrowth || missingTail) {
      throw new Error(
        "ChatGPT composer prompt verification failed " +
          "(prompt " + text.length +
          " chars, composer growth " + growth +
          " chars, total " + actual.length + ").",
      );
    }
  }

  async #mentionSuggestionVisible(
    page: Page,
    composer: Locator,
    connectorName: string,
  ): Promise<boolean> {
    const composerHandle = await composer.elementHandle().catch(() => null);
    return await page.evaluate(
      ({ name, composerElement }) => {
        const visible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") === 0
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const elements = Array.from(document.querySelectorAll("body *"));
        return elements.some(element => {
          if (!visible(element)) return false;
          if ((element.textContent || "").trim() !== name) return false;

          // Ignore the already-attached inline plugin pill/detail link.
          const pluginLink = element.closest('a[href*="/plugins/"]');
          if (pluginLink) return false;

          // Ignore text rendered inside the composer itself.
          if (
            composerElement instanceof Element &&
            composerElement.contains(element)
          ) {
            return false;
          }

          return true;
        });
      },
      { name: connectorName, composerElement: composerHandle },
    ).catch(() => false);
  }

  async #mentionConnector(
    page: Page,
    composer: Locator,
    connectorName: string,
  ): Promise<void> {
    const mentionQuery =
      connectorName.trim().split(/\s+/)[0] || connectorName;

    await composer.fill("@" + mentionQuery);

    const currentMentionText = (
      (await composer.innerText().catch(() => "")) ||
      (await composer.inputValue().catch(() => ""))
    ).trim();

    if (currentMentionText !== "@" + mentionQuery) {
      await composer.fill("");
      await composer.fill("@" + mentionQuery);
    }

    // Do not click connector labels: ChatGPT can render the attached app name
    // as an inline plugin-detail link. Instead, as soon as the visible
    // @mention suggestion text appears anywhere outside the composer/plugin
    // pill, accept the highlighted suggestion with Enter.
    const mentionDeadline = Date.now() + 12_000;
    let detected = false;

    while (Date.now() < mentionDeadline) {
      if (page.isClosed()) throw new Error("ChatGPT tab was closed.");

      if (await this.#mentionSuggestionVisible(page, composer, connectorName)) {
        detected = true;
        break;
      }

      const mentionText = (
        (await composer.innerText().catch(() => "")) ||
        (await composer.inputValue().catch(() => ""))
      ).trim();

      if (mentionText !== "@" + mentionQuery) {
        throw new Error(
          'ChatGPT @mention query changed while waiting for "' +
            connectorName +
            '": "' +
            mentionText +
            '"',
        );
      }

      // Poll quickly so Enter lands almost immediately after the popup appears.
      await sleep(50);
    }

    if (!detected) {
      throw new Error(
        'ChatGPT did not visibly offer "' +
          connectorName +
          '" within 12 seconds after typing "@' +
          mentionQuery +
          '".',
      );
    }

    await composer.press("Enter");
    await sleep(250);

    const composerContainer = composer.locator(
      "xpath=ancestor::*[self::form or @data-type='unified-composer'][1]",
    );
    const mentioned = await firstVisible(
      [
        composerContainer.getByText(connectorName, { exact: true }),
        page
          .locator(
            '[data-mention], [data-app-id], [data-testid*="mention"]',
          )
          .filter({ hasText: connectorName }),
      ],
      1_000,
    );

    if (!mentioned) {
      const currentText = (
        await composer.innerText().catch(() => "")
      ).trim();
      const currentValue = (
        await composer.inputValue().catch(() => "")
      ).trim();
      const plain = currentText || currentValue;
      if (plain === "@" + mentionQuery) {
        throw new Error(
          'ChatGPT app "' +
            connectorName +
            '" suggestion was accepted but the mention did not attach to the composer.',
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
      .locator(
        '[aria-pressed="true"], [data-state="checked"], [data-state="on"]',
      )
      .filter({ hasText: connectorName });
    const container = composer.locator(
      "xpath=ancestor::*[self::form or @data-type='unified-composer'][1]",
    );
    const nearComposer = container.getByText(connectorName, {
      exact: true,
    });
    const attached = await firstVisible([selected, nearComposer], 100);
    if (attached) {
      throw new Error(
        'Text-only compaction requires a fresh ChatGPT chat with no "' +
          connectorName +
          '" connector attached.',
      );
    }
  }

  async #waitForSubmissionEvidence(
    page: Page,
    baselineUserTurns = 0,
  ): Promise<void> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("ChatGPT tab was closed.");
      const userTurns = page.locator('[data-message-author-role="user"]');
      if ((await userTurns.count().catch(() => 0)) > baselineUserTurns) {
        return;
      }

      const stop = await this.#stopButton(page);
      if (stop) return;
      await sleep(250);
    }
    throw new Error(
      "ChatGPT Web did not show evidence that the OMP provider prompt was submitted.",
    );
  }

  async #stopButton(page: Page): Promise<Locator | undefined> {
    return firstVisible(
      [
        page.locator('button[data-testid="stop-button"]'),
        page.getByRole("button", {
          name: /Stop streaming|Stop generating/i,
        }),
        page.getByRole("button", { name: /생성 중지|응답 중지/ }),
      ],
      100,
    );
  }

  async #waitUntilIdle(
    page: Page,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let idleSince = 0;

    // Give the browser time to consume the MCP response for omp_turn_complete.
    await sleep(400);

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException("ChatGPT turn settlement aborted", "AbortError");
      }
      if (page.isClosed()) throw new Error("ChatGPT tab was closed.");

      const stop = await this.#stopButton(page);
      if (!stop) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= 700) return;
      } else {
        idleSince = 0;
      }
      await sleep(200);
    }
  }

  async #waitForAssistantText(
    page: Page,
    timeoutMs: number,
    signal?: AbortSignal,
    baselineAssistantTurns = 0,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let stableSince = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException("Text-only Web request aborted", "AbortError");
      }
      if (page.isClosed()) throw new Error("ChatGPT tab was closed.");

      const assistantTurns = page.locator(
        '[data-message-author-role="assistant"]',
      );
      const count = await assistantTurns.count().catch(() => 0);
      if (count > baselineAssistantTurns) {
        const text = (
          await assistantTurns
            .nth(count - 1)
            .innerText()
            .catch(() => "")
        ).trim();
        if (text && text === lastText) {
          if (!stableSince) stableSince = Date.now();
        } else if (text) {
          lastText = text;
          stableSince = Date.now();
        }
      }

      const stop = await this.#stopButton(page);
      if (
        lastText &&
        stableSince &&
        Date.now() - stableSince >= 1_500 &&
        !stop
      ) {
        return lastText;
      }
      await sleep(250);
    }

    throw new Error(
      "ChatGPT Web text-only request timed out after " + timeoutMs + "ms.",
    );
  }

  async #approveOnce(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const allow = await firstVisible(
      [
        page.getByRole("button", { name: /Allow once/i }),
        page.getByRole("button", { name: /한 번 허용/ }),
      ],
      100,
    );
    if (allow) await allow.click().catch(() => undefined);
  }
}
