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
  insertMode: "execCommand" | "cdp";
  insertEditMs: number;
  insertVerifyMs: number;
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

  async #recoverUnsubmittedTurn(
    sessionKey: string,
    composer?: Locator,
  ): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    if (turn?.approvalTimer) clearInterval(turn.approvalTimer);
    this.#turns.delete(sessionKey);

    // Preparation/mention/insertion failures happen before submission is
    // accepted. Preserve the retained conversation and just clear the draft
    // instead of closing the only ChatGPT tab. This also prevents an outer
    // provider retry from relaunching a brand-new Chrome window.
    if (composer) {
      await composer.fill("").catch(() => undefined);
    }
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

    // OMP ChatGPT Web intentionally keeps retained work on Temporary Chat.
    // Do not reload/rehydrate the page between turns: a temporary conversation
    // has no durable /c/<id> URL whose history can be safely reconstructed.
    const page = session.page;
    let composer: Locator;
    try {
      composer = await this.#requireComposer(page);
      composer = await this.#mentionConnector(
        page,
        composer,
        config.connectorName,
      );
    } catch (error) {
      await this.#recoverUnsubmittedTurn(sessionKey, composer);
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

    let insertion: {
      mode: "execCommand" | "cdp";
      editMs: number;
      verifyMs: number;
    };
    let insertedAt: number;

    try {
      insertion = await this.#insertComposerText(
        page,
        composer,
        " " + prompt,
      );
      insertedAt = Date.now();
    } catch (error) {
      await this.#recoverUnsubmittedTurn(sessionKey, composer);
      throw error;
    }

    try {
      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page, baselineUsers);
      const submittedAt = Date.now();
      this.#lastPreparation = {
        promptChars: prompt.length,
        sessionMs: sessionReadyAt - preparationStartedAt,
        mentionMs: mentionReadyAt - sessionReadyAt,
        insertMs: insertedAt - mentionReadyAt,
        insertMode: insertion.mode,
        insertEditMs: insertion.editMs,
        insertVerifyMs: insertion.verifyMs,
        submitMs: submittedAt - insertedAt,
      };
      session.seeded = true;
      session.lastUsedAt = Date.now();
    } catch (error) {
      // After Enter, submission state is ambiguous. A retry must not append to
      // a possibly-submitted retained thread, so invalidate only this case.
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

  async #composerPromptText(composer: Locator): Promise<string> {
    return await composer.evaluate(element => {
      if (
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement
      ) {
        return element.value;
      }

      // Match codex-chatgpt-web's retained-composer readback strategy:
      // inspect a detached clone via textContent so verification does not force
      // layout across the increasingly large ChatGPT conversation DOM.
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], ' +
          '[data-inline-selection-pill-cursor-target], ' +
          '[data-mention], [data-app-id], [data-testid*="mention"]',
      ).forEach(part => part.remove());

      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    });
  }

  #verifyComposerInsertion(
    before: string,
    actual: string,
    text: string,
  ): boolean {
    const normalize = (value: string): string =>
      value
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .replace(/\s+/g, " ")
        .trim();

    const normalizedPrompt = normalize(text);
    const normalizedBefore = normalize(before);
    const normalizedActual = normalize(actual);
    const fingerprintSize = Math.min(2_048, normalizedPrompt.length);
    const tail = normalizedPrompt.slice(-fingerprintSize);

    const growth = normalizedActual.length - normalizedBefore.length;
    const minGrowth = Math.floor(normalizedPrompt.length * 0.9);
    const maxGrowth = Math.ceil(normalizedPrompt.length * 1.2) + 8_192;

    return (
      growth >= minGrowth &&
      growth <= maxGrowth &&
      (tail.length === 0 || normalizedActual.includes(tail))
    );
  }

  async #insertComposerText(
    page: Page,
    composer: Locator,
    text: string,
  ): Promise<{
    mode: "execCommand" | "cdp";
    editMs: number;
    verifyMs: number;
  }> {
    await composer.focus();
    const before = await this.#composerPromptText(composer);
    const editStartedAt = Date.now();

    // Backend-only inline insertion. No OS clipboard, no foreground-window
    // activation, and no synthetic paste events that ChatGPT may promote to
    // a "Pasted text" attachment.
    const inserted = await composer.evaluate((element, value) => {
      const el = element as HTMLElement;
      if (document.activeElement !== el) el.focus();
      if (document.activeElement !== el) return false;

      const selection = window.getSelection();
      if (!selection) return false;
      const alreadyPlaced =
        selection.isCollapsed &&
        selection.anchorNode !== null &&
        el.contains(selection.anchorNode);

      if (!alreadyPlaced) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      if (
        !selection.isCollapsed ||
        !selection.anchorNode ||
        !el.contains(selection.anchorNode)
      ) {
        return false;
      }

      return document.execCommand("insertText", false, String(value));
    }, text).catch(() => false);

    let mode: "execCommand" | "cdp" = "execCommand";
    if (!inserted) {
      await composer.focus();
      await page.keyboard.insertText(text);
      mode = "cdp";
    }

    const editedAt = Date.now();
    const actual = await this.#composerPromptText(composer);
    const verifiedAt = Date.now();

    if (!this.#verifyComposerInsertion(before, actual, text)) {
      throw new Error(
        "ChatGPT composer prompt verification failed " +
          "(prompt " + text.length +
          " chars, observed " + actual.length + " chars).",
      );
    }

    return {
      mode,
      editMs: editedAt - editStartedAt,
      verifyMs: verifiedAt - editedAt,
    };
  }

  async #selectedConnectorIsExact(
    composer: Locator,
    connectorName: string,
  ): Promise<boolean> {
    const selected = composer
      .locator('[data-id^="plugin:"][data-keyword]')
      .filter({ visible: true });

    const keywords = await selected
      .evaluateAll(elements =>
        elements.map(element => element.getAttribute("data-keyword")),
      )
      .catch(() => [] as Array<string | null>);

    const exact = keywords.filter(keyword => keyword === connectorName).length;
    if (exact > 1) {
      throw new Error(
        'ChatGPT composer exposed duplicate connector selections for "' +
          connectorName +
          '".',
      );
    }
    return exact === 1;
  }

  async #mentionConnector(
    page: Page,
    composer: Locator,
    connectorName: string,
  ): Promise<Locator> {
    // A retained/fresh surface may already expose the selected connector.
    if (await this.#selectedConnectorIsExact(composer, connectorName)) {
      return composer;
    }

    const mentionQuery =
      connectorName.trim().split(/\s+/)[0] || connectorName;

    await composer.fill("");
    await composer.focus();
    await composer.fill("@" + mentionQuery);

    const currentMentionText = (
      (await composer.textContent().catch(() => "")) ||
      (await composer.inputValue().catch(() => ""))
    ).trim();

    if (currentMentionText !== "@" + mentionQuery) {
      throw new Error(
        'ChatGPT did not preserve the @mention query "@' +
          mentionQuery +
          '".',
      );
    }

    // Current ChatGPT connector menus expose keyboard-owned menu rows with
    // tabindex=0. Prove the exact OMP Local row, then ensure that exact row is
    // highlighted before pressing Enter. Merely seeing the label is not enough.
    const menuRows = page
      .locator('.__menu-item[tabindex="0"]')
      .filter({ visible: true });
    const exactRow = menuRows.filter({
      has: page.getByText(connectorName, { exact: true }),
    });

    const deadline = Date.now() + 12_000;
    let exactVisible = false;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("ChatGPT tab was closed.");

      const count = await exactRow.count().catch(() => 0);
      if (count === 1 && await exactRow.first().isVisible().catch(() => false)) {
        exactVisible = true;
        break;
      }
      if (count > 1) {
        throw new Error(
          'ChatGPT exposed multiple exact @mention rows for "' +
            connectorName +
            '".',
        );
      }

      await sleep(50);
    }

    if (!exactVisible) {
      throw new Error(
        'ChatGPT did not expose one exact @mention menu row for "' +
          connectorName +
          '" within 12 seconds.',
      );
    }

    const row = exactRow.first();
    const highlighted = async (): Promise<boolean> =>
      (await row.getAttribute("data-highlighted").catch(() => null)) !== null;

    if (!(await highlighted())) {
      const visibleRows = await menuRows.count().catch(() => 0);
      for (
        let step = 0;
        step < Math.max(1, visibleRows) && !(await highlighted());
        step += 1
      ) {
        await composer.press("ArrowDown");
        await sleep(25);
      }
    }

    if (!(await highlighted())) {
      throw new Error(
        'ChatGPT @mention menu could not highlight "' +
          connectorName +
          '".',
      );
    }

    await composer.press("Enter");

    // Connector selection can replace the Lexical composer subtree. Resolve
    // the active composer again, then fail closed unless the exact app pill is
    // present. This prevents a first turn from silently proceeding unbound.
    const selectedComposer = await this.#requireComposer(page);
    const selectionDeadline = Date.now() + 5_000;
    while (Date.now() < selectionDeadline) {
      if (await this.#selectedConnectorIsExact(
        selectedComposer,
        connectorName,
      )) {
        return selectedComposer;
      }
      await sleep(50);
    }

    throw new Error(
      'ChatGPT did not attach the exact connector "' +
        connectorName +
        '" after accepting the @mention.',
    );
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
