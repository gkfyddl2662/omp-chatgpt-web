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
import { assertValidCompactionSummary } from "./compaction.js";

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

type ChatErrorBaseline = {
  retryCount: number;
  errorTextCount: number;
};

const CHAT_ERROR_RETRY_BUTTON_RE = /Retry|Try again|다시 시도/i;
const CHAT_ERROR_TEXT_RE =
  /Something went wrong(?:\.|$)|If this issue persists|please contact us through our help center|문제가 발생했습니다|오류가 발생했습니다|메시지 전송 시간이 초과되었습니다|다시 시도해 주세요/i;

export class ChatGptReplayUnsafeTurnError extends Error {
  readonly browserMessage: string;

  constructor(browserMessage: string) {
    super(
      "ChatGPT Web ended the browser turn before OMP completion. " +
        "Automatic replay was suppressed to preserve already-completed OMP tool work.",
    );
    this.name = "ChatGptReplayUnsafeTurnError";
    this.browserMessage = browserMessage;
  }
}

interface BrowserTurn {
  page: Page;
  errorBaseline: ChatErrorBaseline;
  approvalTimer?: ReturnType<typeof setInterval>;
  settling?: Promise<void>;
}

interface BrowserSession {
  page: Page;
  seeded: boolean;
}

type BrowserPreparationKind = "turn" | "retained-compaction" | "fresh-compaction";

interface ComposerInsertionTiming {
  mode: "prosemirror" | "lexical" | "execCommand" | "cdp";
  editMs: number;
  verifyMs: number;
  detail?: string;
}

interface BrowserPreparationTiming {
  kind: BrowserPreparationKind;
  promptChars: number;
  sessionMs: number;
  mentionMs: number;
  insertMs: number;
  insertMode: ComposerInsertionTiming["mode"];
  insertDetail?: string;
  insertEditMs: number;
  insertVerifyMs: number;
  submitMs: number;
}

export class ChatGptBrowserBackend {
  #browser?: Browser;
  #context?: BrowserContext;
  #connecting?: Promise<BrowserContext>;
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
    if (this.#connecting) return await this.#connecting;

    const connecting = this.#connectFresh(config);
    this.#connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }

  async #connectFresh(config: RuntimeConfig): Promise<BrowserContext> {
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

  async #releasePageWithoutStoppingBrowser(page: Page): Promise<void> {
    if (page.isClosed()) {
      this.#reservedPages.delete(page);
      return;
    }

    // Keep ownership while the page is being retired so another concurrent
    // request cannot acquire it as an idle page halfway through navigation.
    this.#reservedPages.add(page);
    try {
      const context = this.#context;
      const hasOtherOpenPage = Boolean(
        context?.pages().some(candidate =>
          candidate !== page && !candidate.isClosed()
        ),
      );

      if (hasOtherOpenPage) {
        await page.close().catch(() => undefined);
        return;
      }

      // Closing Chrome's final tab can tear down the whole dedicated automation
      // browser. Retire the stale/transient surface to about:blank instead so
      // the process stays warm and the next request can reuse this page.
      try {
        await page.goto("about:blank", {
          waitUntil: "domcontentloaded",
          timeout: 5_000,
        });
      } catch {
        await page.close().catch(() => undefined);
      }
    } finally {
      this.#reservedPages.delete(page);
    }
  }

  async #newSessionPage(config: RuntimeConfig): Promise<Page> {
    const page = await this.#acquireUnownedPage(config);
    try {
      await this.#navigateFreshChat(page, config);
      return page;
    } catch (error) {
      await this.#releasePageWithoutStoppingBrowser(page);
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
      return existing;
    }

    if (existing) this.#sessions.delete(sessionKey);
    const page = await this.#newSessionPage(config);
    const session: BrowserSession = {
      page,
      seeded: false,
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

  async waitForTurnFailure(
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<never> {
    const turn = this.#turns.get(sessionKey);
    if (!turn) {
      throw new Error(
        "Cannot monitor ChatGPT browser failure without an active Web turn.",
      );
    }

    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException("ChatGPT browser failure monitor aborted", "AbortError");
      }

      // If another path finished the turn first, stay dormant until the caller
      // cancels this monitor. This keeps Promise.race from turning a successful
      // MCP action into a spurious provider failure during teardown.
      if (this.#turns.get(sessionKey) !== turn) {
        await sleep(100);
        continue;
      }

      if (turn.page.isClosed()) {
        throw new ChatGptReplayUnsafeTurnError("ChatGPT tab was closed.");
      }

      const errorState = await this.#chatErrorState(
        turn.page,
        turn.errorBaseline,
      );
      if (errorState) {
        // Never click ChatGPT's Retry button for an ordinary OMP turn. A long
        // agent turn may already have completed side-effecting tools, so replay
        // must be delegated to OMP's state-aware continuation machinery.
        throw new ChatGptReplayUnsafeTurnError(errorState.message);
      }

      await sleep(250);
    }
  }

  async status(config?: RuntimeConfig): Promise<{
    open: boolean;
    attached: boolean;
    tabs: number;
    retainedSessions: number;
    activeTurns: number;
    pendingCompactions: number;
    lastPreparation?: BrowserPreparationTiming;
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
      ...(this.#lastPreparation
        ? { lastPreparation: { ...this.#lastPreparation } }
        : {}),
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
    await this.waitForTurnIdle(sessionKey);

    if (this.#turns.has(sessionKey)) {
      throw new Error(
        "ChatGPT Web turn already exists for session " + sessionKey,
      );
    }

    const preparationStartedAt = Date.now();
    const session = await this.#session(sessionKey, config);
    const sessionReadyAt = Date.now();

    // Retained work stays on the live Temporary Chat page. Temporary Chat has
    // no durable conversation URL, so the backend never reloads it between
    // ordinary turns.
    const page = session.page;
    let composer: Locator | undefined;
    try {
      const initialComposer = await this.#requireComposer(page);
      composer = await this.#mentionConnector(
        page,
        initialComposer,
        config.connectorName,
      );
    } catch (error) {
      await this.#recoverUnsubmittedTurn(sessionKey, composer);
      throw error;
    }
    if (!composer) {
      throw new Error("ChatGPT composer was unavailable after connector selection.");
    }
    const mentionReadyAt = Date.now();

    const errorBaseline = await this.#chatErrorBaseline(page);
    const turn: BrowserTurn = { page, errorBaseline };
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

    let insertion: ComposerInsertionTiming;
    let insertedAt: number;

    try {
      insertion = await this.#insertComposerText(
        page,
        composer,
        " " + prompt,
        config.insertMode,
      );
      if (!(await this.#selectedConnectorIsExact(composer, config.connectorName))) {
        throw new Error(
          'ChatGPT lost the exact connector "' +
            config.connectorName +
            '" while inserting the provider prompt.',
        );
      }
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
        kind: "turn",
        promptChars: prompt.length,
        sessionMs: sessionReadyAt - preparationStartedAt,
        mentionMs: mentionReadyAt - sessionReadyAt,
        insertMs: insertedAt - mentionReadyAt,
        insertMode: insertion.mode,
        ...(insertion.detail ? { insertDetail: insertion.detail } : {}),
        insertEditMs: insertion.editMs,
        insertVerifyMs: insertion.verifyMs,
        submitMs: submittedAt - insertedAt,
      };
      session.seeded = true;
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
    _signal?: AbortSignal,
  ): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    if (!turn) return;

    if (turn.approvalTimer) {
      clearInterval(turn.approvalTimer);
      turn.approvalTimer = undefined;
    }

    if (turn.page.isClosed()) {
      this.#turns.delete(sessionKey);
      return;
    }

    // Logical completion (omp_turn_complete) can arrive a little before the
    // ChatGPT UI physically stops generating. Keep the turn owned until the
    // stop button has actually disappeared, but do that in the background so
    // OMP can receive the final answer immediately. The next ordinary turn and
    // retained compaction both wait on #turns, so neither can race this tail.
    if (!turn.settling) {
      turn.settling = this.#waitUntilIdle(
        turn.page,
        config.turnTimeoutMs,
      )
        .catch(async () => {
          await this.invalidateSession(sessionKey);
        })
        .finally(() => {
          if (this.#turns.get(sessionKey) === turn) {
            this.#turns.delete(sessionKey);
          }
        });
    }
  }

  async #resetSessionPage(
    sessionKey: string,
    config: RuntimeConfig,
  ): Promise<void> {
    const session = this.#sessions.get(sessionKey);
    if (!session) return;

    const previousPage = session.page;
    if (previousPage.isClosed() || !this.#browser?.isConnected()) {
      this.#sessions.delete(sessionKey);
      return;
    }

    // Prepare the fresh Temporary Chat first. Only after the replacement is
    // fully usable do we retire the compacted conversation. This prevents the
    // visible "last tab closes -> Chrome exits -> Chrome relaunches" cycle.
    let replacement: Page;
    try {
      replacement = await this.#newSessionPage(config);
    } catch (error) {
      // The compacted thread must not receive an ordinary full seed after its
      // history was rewritten. Remove ownership, but keep Chrome alive by
      // retiring the stale page to about:blank when it is the final tab.
      this.#sessions.delete(sessionKey);
      await this.#releasePageWithoutStoppingBrowser(previousPage);
      throw error;
    }

    this.#sessions.set(sessionKey, {
      page: replacement,
      seeded: false,
    });
    this.#reservedPages.delete(replacement);
    await this.#releasePageWithoutStoppingBrowser(previousPage);
  }

  async compactSessionWhenIdle(
    sessionKey: string,
    prompts: { retained: string; fresh: string },
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

      // Prefer the short retained-thread compaction whenever that conversation
      // survived. If the browser turn was invalidated (for example after a
      // ChatGPT timeout), OMP's compaction side request still contains the full
      // source conversation. Run that dedicated maintenance prompt in a fresh
      // Temporary Chat instead of falling back to a different model or replaying
      // the ordinary agent turn.
      if (this.hasRetainedConversation(sessionKey)) {
        try {
          return await this.compactRetainedSession(
            sessionKey,
            prompts.retained,
            config,
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          // The retained page survived the ordinary-turn failure, so prefer it
          // and keep the compact prompt on that exact thread. If ChatGPT's
          // failed-turn surface makes the composer unusable, retained
          // compaction invalidates that page and this maintenance-only request
          // can safely retry once in a fresh Temporary Chat.
        }
      }

      return await this.compactFreshSession(
        sessionKey,
        prompts.fresh,
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

    const preparationStartedAt = Date.now();
    const page = session.page;
    let composer = await this.#requireComposer(page);
    composer = await this.#prepareCompactionComposer(
      page,
      composer,
      config.connectorName,
    );
    const composerReadyAt = Date.now();

    const baselineAssistants = await page
      .locator('[data-message-author-role="assistant"]')
      .count()
      .catch(() => 0);
    const baselineUsers = await page
      .locator('[data-message-author-role="user"]')
      .count()
      .catch(() => 0);
    const errorBaseline = await this.#chatErrorBaseline(page);

    try {
      const insertion = await this.#insertComposerText(
        page,
        composer,
        prompt,
        config.insertMode,
      );
      const insertedAt = Date.now();

      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page, baselineUsers);
      const submittedAt = Date.now();
      this.#lastPreparation = {
        kind: "retained-compaction",
        promptChars: prompt.length,
        sessionMs: composerReadyAt - preparationStartedAt,
        mentionMs: 0,
        insertMs: insertedAt - composerReadyAt,
        insertMode: insertion.mode,
        ...(insertion.detail ? { insertDetail: insertion.detail } : {}),
        insertEditMs: insertion.editMs,
        insertVerifyMs: insertion.verifyMs,
        submitMs: submittedAt - insertedAt,
      };

      const summary = assertValidCompactionSummary(
        await this.#waitForAssistantText(
          page,
          config.turnTimeoutMs,
          signal,
          baselineAssistants,
          errorBaseline,
        ),
        prompt,
      );

      // The compact response is generated from the retained thread, but OMP
      // rewrites its history after accepting that summary. Prepare a fresh
      // replacement Temporary Chat before retiring the old thread so Chrome
      // never has to close/relaunch between handoff and the next ordinary turn.
      await this.#resetSessionPage(sessionKey, config);
      return summary;
    } catch (error) {
      await this.invalidateSession(sessionKey);
      throw error;
    }
  }


  async compactFreshSession(
    sessionKey: string,
    prompt: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.#turns.has(sessionKey)) {
      throw new Error(
        "Cannot submit fresh Web compaction while the ChatGPT turn is still active.",
      );
    }

    const existing = this.#sessions.get(sessionKey);
    if (
      existing &&
      existing.seeded &&
      !existing.page.isClosed() &&
      this.#browser?.isConnected()
    ) {
      throw new Error(
        "Fresh Web compaction refused to replace a usable retained ChatGPT conversation.",
      );
    }

    const preparationStartedAt = Date.now();
    const session = await this.#session(sessionKey, config);
    if (session.seeded) {
      throw new Error(
        "Fresh Web compaction requires an unseeded Temporary Chat.",
      );
    }

    const page = session.page;
    let composer = await this.#requireComposer(page);
    composer = await this.#prepareCompactionComposer(
      page,
      composer,
      config.connectorName,
    );
    const composerReadyAt = Date.now();

    const baselineAssistants = await page
      .locator('[data-message-author-role="assistant"]')
      .count()
      .catch(() => 0);
    const baselineUsers = await page
      .locator('[data-message-author-role="user"]')
      .count()
      .catch(() => 0);
    const errorBaseline = await this.#chatErrorBaseline(page);

    try {
      const insertion = await this.#insertComposerText(
        page,
        composer,
        prompt,
        config.insertMode,
      );
      const insertedAt = Date.now();

      await composer.press("Enter");
      await this.#waitForSubmissionEvidence(page, baselineUsers);
      const submittedAt = Date.now();
      this.#lastPreparation = {
        kind: "fresh-compaction",
        promptChars: prompt.length,
        sessionMs: composerReadyAt - preparationStartedAt,
        mentionMs: 0,
        insertMs: insertedAt - composerReadyAt,
        insertMode: insertion.mode,
        ...(insertion.detail ? { insertDetail: insertion.detail } : {}),
        insertEditMs: insertion.editMs,
        insertVerifyMs: insertion.verifyMs,
        submitMs: submittedAt - insertedAt,
      };

      const summary = assertValidCompactionSummary(
        await this.#waitForAssistantText(
          page,
          config.turnTimeoutMs,
          signal,
          baselineAssistants,
          errorBaseline,
        ),
        prompt,
      );

      // This page contains only the one-off OMP maintenance side request.
      // OMP rewrites its canonical history after accepting the summary, so the
      // next ordinary turn must start on another clean Temporary Chat and seed
      // the compacted OMP context there.
      await this.#resetSessionPage(sessionKey, config);
      return summary;
    } catch (error) {
      await this.invalidateSession(sessionKey);
      throw error;
    }
  }


  async releaseReplayUnsafeTurnForMaintenance(
    sessionKey: string,
  ): Promise<boolean> {
    const turn = this.#turns.get(sessionKey);
    if (turn?.approvalTimer) clearInterval(turn.approvalTimer);
    this.#turns.delete(sessionKey);

    const session = this.#sessions.get(sessionKey);
    if (
      !session ||
      session.page.isClosed() ||
      !this.#browser?.isConnected()
    ) {
      this.#sessions.delete(sessionKey);
      return false;
    }

    // A ChatGPT timeout/retry surface means the current model turn cannot be
    // replayed safely, but the page still contains the exact retained history
    // that OMP wants to compact. Keep that page and seeded state intact. The
    // compaction path snapshots the existing error UI as its baseline, so the
    // old Retry card is not mistaken for a new compaction failure.
    return true;
  }

  async invalidateSession(sessionKey: string): Promise<void> {
    const turn = this.#turns.get(sessionKey);
    if (turn?.approvalTimer) clearInterval(turn.approvalTimer);
    this.#turns.delete(sessionKey);

    const session = this.#sessions.get(sessionKey);
    this.#sessions.delete(sessionKey);
    if (session && !session.page.isClosed()) {
      await this.#releasePageWithoutStoppingBrowser(session.page);
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
    this.#connecting = undefined;
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
    strategy: RuntimeConfig["insertMode"],
  ): Promise<ComposerInsertionTiming> {
    await composer.focus();
    const before = await this.#composerPromptText(composer);
    const editStartedAt = Date.now();

    let inserted = false;
    let mode: "prosemirror" | "lexical" | "execCommand" | "cdp" = "execCommand";
    let detail: string | undefined;

    if (strategy === "editor") {
      const proseMirror = await composer.evaluate((element, value) => {
        type EditorViewLike = {
          dom?: HTMLElement;
          state?: {
            doc?: unknown;
            selection?: { from?: number; to?: number };
            tr?: {
              insertText?: (
                text: string,
                from?: number,
                to?: number,
              ) => unknown;
            };
          };
          dispatch?: (transaction: unknown) => void;
          focus?: () => void;
        };

        const isEditorView = (value: unknown): value is EditorViewLike => {
          if (!value || typeof value !== "object") return false;
          const candidate = value as EditorViewLike;
          return Boolean(
            typeof candidate.dispatch === "function" &&
            candidate.state?.doc &&
            candidate.state?.tr,
          );
        };

        const findInGraph = (
          root: unknown,
          maxDepth: number,
          maxNodes: number,
        ): EditorViewLike | undefined => {
          if (!root || typeof root !== "object") return undefined;

          const seen = new WeakSet<object>();
          const queue: Array<{ value: object; depth: number }> = [
            { value: root as object, depth: 0 },
          ];
          let visited = 0;

          while (queue.length > 0 && visited < maxNodes) {
            const item = queue.shift();
            if (!item) break;
            const value = item.value;
            if (seen.has(value)) continue;
            seen.add(value);
            visited += 1;

            if (isEditorView(value)) return value;
            if (
              item.depth >= maxDepth ||
              value instanceof Node ||
              value === window ||
              value === document
            ) {
              continue;
            }

            let propertyNames: string[];
            try {
              propertyNames = Object.getOwnPropertyNames(value);
            } catch {
              continue;
            }

            for (const propertyName of propertyNames) {
              let child: unknown;
              try {
                child = (value as Record<string, unknown>)[propertyName];
              } catch {
                continue;
              }
              if (
                child &&
                typeof child === "object" &&
                !seen.has(child as object)
              ) {
                queue.push({
                  value: child as object,
                  depth: item.depth + 1,
                });
              }
            }
          }

          return undefined;
        };

        const findFromElement = (
          root: HTMLElement,
          expectedComposer: HTMLElement,
        ): EditorViewLike | undefined => {
          let current: HTMLElement | null = root;

          while (current) {
            let propertyNames: string[] = [];
            try {
              propertyNames = Object.getOwnPropertyNames(current);
            } catch {
              // Keep walking ancestors.
            }

            for (const propertyName of propertyNames) {
              let candidate: unknown;
              try {
                candidate = (
                  current as HTMLElement & Record<string, unknown>
                )[propertyName];
              } catch {
                continue;
              }

              const direct = isEditorView(candidate)
                ? candidate
                : findInGraph(candidate, 4, 400);
              if (
                direct &&
                direct.dom instanceof HTMLElement &&
                (
                  direct.dom === expectedComposer ||
                  direct.dom.contains(expectedComposer) ||
                  expectedComposer.contains(direct.dom)
                )
              ) {
                return direct;
              }
            }

            const pmViewDesc = (
              current as HTMLElement & { pmViewDesc?: unknown }
            ).pmViewDesc;
            const fromPm = findInGraph(pmViewDesc, 7, 1_000);
            if (
              fromPm &&
              fromPm.dom instanceof HTMLElement &&
              (
                fromPm.dom === expectedComposer ||
                fromPm.dom.contains(expectedComposer) ||
                expectedComposer.contains(fromPm.dom)
              )
            ) {
              return fromPm;
            }

            current = current.parentElement;
          }

          return undefined;
        };

        const el = element as HTMLElement;
        const candidates: HTMLElement[] = [el];
        const closestProseMirror = el.closest(".ProseMirror");
        if (
          closestProseMirror instanceof HTMLElement &&
          closestProseMirror !== el
        ) {
          candidates.push(closestProseMirror);
        }
        const promptTextArea = document.querySelector("#prompt-textarea");
        if (
          promptTextArea instanceof HTMLElement &&
          !candidates.includes(promptTextArea)
        ) {
          candidates.push(promptTextArea);
        }
        const visibleProseMirror = document.querySelector(".ProseMirror");
        if (
          visibleProseMirror instanceof HTMLElement &&
          !candidates.includes(visibleProseMirror)
        ) {
          candidates.push(visibleProseMirror);
        }

        let view: EditorViewLike | undefined;
        for (const candidate of candidates) {
          view = findFromElement(candidate, el);
          if (view) break;
        }

        if (!view?.state || typeof view.dispatch !== "function") {
          return {
            status: "unavailable" as const,
            reason: "prosemirror-view-not-found",
          };
        }

        const selection = view.state.selection;
        const transaction = view.state.tr;
        if (
          !selection ||
          typeof selection.from !== "number" ||
          typeof selection.to !== "number" ||
          !transaction ||
          typeof transaction.insertText !== "function"
        ) {
          return {
            status: "unavailable" as const,
            reason: "prosemirror-transaction-unavailable",
          };
        }

        let dispatchStarted = false;
        try {
          view.focus?.();
          const latestState = view.state;
          const latestSelection = latestState?.selection ?? selection;
          const latestTransaction = latestState?.tr ?? transaction;
          if (
            !latestSelection ||
            typeof latestSelection.from !== "number" ||
            typeof latestSelection.to !== "number" ||
            !latestTransaction ||
            typeof latestTransaction.insertText !== "function"
          ) {
            return {
              status: "unavailable" as const,
              reason: "prosemirror-selection-unavailable",
            };
          }

          // Insert after the current selection rather than replacing it.
          // If ChatGPT leaves the connector pill as a ProseMirror NodeSelection,
          // selection.to is the position immediately after that atom, so the
          // app pill remains attached.
          const insertionPos = latestSelection.to;
          const next = latestTransaction.insertText(
            String(value),
            insertionPos,
            insertionPos,
          );
          dispatchStarted = true;
          view.dispatch(next);
          view.focus?.();
          return {
            status: "inserted" as const,
            reason: "prosemirror-transaction",
          };
        } catch {
          return {
            status: dispatchStarted ? "ambiguous" as const : "unavailable" as const,
            reason: dispatchStarted
              ? "prosemirror-dispatch-ambiguous"
              : "prosemirror-insert-failed",
          };
        }
      }, text).catch(() => ({
        status: "unavailable" as const,
        reason: "prosemirror-probe-error",
      }));

      if (proseMirror.status === "ambiguous") {
        throw new Error(
          "ChatGPT ProseMirror insertion became ambiguous after dispatch; " +
            "refusing to retry and risk duplicate prompt text.",
        );
      }
      if (proseMirror.status === "inserted") {
        inserted = true;
        mode = "prosemirror";
        detail = proseMirror.reason;
      } else {
        detail = proseMirror.reason;
      }

      if (!inserted) {
        const lexical = await composer.evaluate((element, value) => {
          type LexicalCommandLike = { type?: string };
          type LexicalEditorLike = {
            _commands?: Map<LexicalCommandLike, unknown>;
            dispatchCommand?: (
              command: LexicalCommandLike,
              payload: string,
            ) => boolean;
            focus?: (
              callback?: () => void,
              options?: { defaultSelection?: "rootStart" | "rootEnd" },
            ) => void;
          };

          const el = element as HTMLElement;
          let current: HTMLElement | null = el;
          let editor: LexicalEditorLike | undefined;

          while (current) {
            const candidate = (
              current as HTMLElement & { __lexicalEditor?: LexicalEditorLike }
            ).__lexicalEditor;
            if (
              candidate &&
              typeof candidate.dispatchCommand === "function" &&
              candidate._commands
            ) {
              editor = candidate;
              break;
            }
            current = current.parentElement;
          }

          if (!editor?.dispatchCommand || !editor._commands) {
            return {
              status: "unavailable" as const,
              reason: "lexical-editor-not-found",
            };
          }

          let insertCommand: LexicalCommandLike | undefined;
          for (const command of editor._commands.keys()) {
            if (command?.type === "CONTROLLED_TEXT_INSERTION_COMMAND") {
              insertCommand = command;
              break;
            }
          }
          if (!insertCommand) {
            return {
              status: "unavailable" as const,
              reason: "lexical-command-not-found",
            };
          }

          let dispatchStarted = false;
          try {
            editor.focus?.(undefined, { defaultSelection: "rootEnd" });
            dispatchStarted = true;
            const handled =
              editor.dispatchCommand(insertCommand, String(value)) === true;
            return handled
              ? {
                  status: "inserted" as const,
                  reason: "lexical-command",
                }
              : {
                  status: "ambiguous" as const,
                  reason: "lexical-command-unhandled-after-dispatch",
                };
          } catch {
            return {
              status: dispatchStarted ? "ambiguous" as const : "unavailable" as const,
              reason: dispatchStarted
                ? "lexical-dispatch-ambiguous"
                : "lexical-insert-failed",
            };
          }
        }, text).catch(() => ({
          status: "unavailable" as const,
          reason: "lexical-probe-error",
        }));

        if (lexical.status === "ambiguous") {
          throw new Error(
            "ChatGPT Lexical insertion became ambiguous after dispatch; " +
              "refusing to retry and risk duplicate prompt text.",
          );
        }
        if (lexical.status === "inserted") {
          inserted = true;
          mode = "lexical";
          detail = lexical.reason;
        } else {
          detail = (detail ? detail + ";" : "") + lexical.reason;
        }
      }
    }

    if (!inserted) {
      // Backend-only inline insertion. No OS clipboard, no foreground-window
      // activation, and no synthetic paste events that ChatGPT may promote to
      // a "Pasted text" attachment.
      inserted = await composer.evaluate((element, value) => {
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
      mode = "execCommand";
    }

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
      ...(detail ? { detail } : {}),
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

    // Connector selection can replace the active editor/composer subtree. Resolve
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

  async #prepareCompactionComposer(
    page: Page,
    composer: Locator,
    connectorName: string,
  ): Promise<Locator> {
    let active = composer;

    // Retained agent turns attach OMP Local as an inline composer pill. A
    // compaction/handoff must be tool-free, so clear any leftover pill/draft
    // before inserting the maintenance prompt.
    if (
      await this.#selectedConnectorIsExact(active, connectorName).catch(() => false)
    ) {
      await active.fill("");
      active = await this.#requireComposer(page);
    }

    const existingText = await this.#composerPromptText(active).catch(() => "");
    if (existingText.trim()) {
      await active.fill("");
      active = await this.#requireComposer(page);
    }

    await this.#assertNoConnectorSelected(
      page,
      active,
      connectorName,
    );
    return active;
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
        'Compaction requires the ChatGPT composer to have no "' +
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

  async #chatErrorBaseline(page: Page): Promise<ChatErrorBaseline> {
    const retryButtons = page.getByRole("button", {
      name: CHAT_ERROR_RETRY_BUTTON_RE,
    });
    const errorText = page.getByText(CHAT_ERROR_TEXT_RE);
    return {
      retryCount: await retryButtons.count().catch(() => 0),
      errorTextCount: await errorText.count().catch(() => 0),
    };
  }

  async #chatErrorState(
    page: Page,
    baseline?: ChatErrorBaseline,
  ): Promise<{
    message: string;
    retry?: Locator;
  } | undefined> {
    const retryButtons = page.getByRole("button", {
      name: CHAT_ERROR_RETRY_BUTTON_RE,
    });
    const errorTexts = page.getByText(CHAT_ERROR_TEXT_RE);

    const retryCount = await retryButtons.count().catch(() => 0);
    const errorTextCount = await errorTexts.count().catch(() => 0);
    const hasNewRetry =
      retryCount > (baseline?.retryCount ?? 0);
    const hasNewErrorText =
      errorTextCount > (baseline?.errorTextCount ?? 0);

    if (!hasNewRetry && !hasNewErrorText) return undefined;

    const retry = hasNewRetry
      ? await firstVisible([retryButtons.nth(retryCount - 1)], 100)
      : undefined;
    const errorText = hasNewErrorText
      ? await firstVisible([errorTexts.nth(errorTextCount - 1)], 100)
      : undefined;

    if (!retry && !errorText) return undefined;

    const message = (
      (await errorText?.innerText().catch(() => "")) ||
      (await retry?.innerText().catch(() => "")) ||
      "ChatGPT reported an unknown retryable error."
    ).trim();

    return {
      message,
      ...(retry ? { retry } : {}),
    };
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

    throw new Error(
      "ChatGPT turn did not physically settle within " + timeoutMs + "ms.",
    );
  }

  async #waitForAssistantText(
    page: Page,
    timeoutMs: number,
    signal?: AbortSignal,
    baselineAssistantTurns = 0,
    errorBaseline?: ChatErrorBaseline,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let stableSince = 0;
    let retryAttempts = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ??
          new DOMException("Text-only Web request aborted", "AbortError");
      }
      if (page.isClosed()) throw new Error("ChatGPT tab was closed.");

      const errorState = await this.#chatErrorState(page, errorBaseline);
      if (errorState) {
        if (retryAttempts < 1 && errorState.retry) {
          retryAttempts += 1;
          lastText = "";
          stableSince = 0;
          await errorState.retry.click();
          await sleep(750);
          continue;
        }
        throw new Error(
          "ChatGPT Web returned an error instead of a valid response: " +
            errorState.message,
        );
      }

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
        const finalErrorState = await this.#chatErrorState(page, errorBaseline);
        if (finalErrorState) {
          throw new Error(
            "ChatGPT Web returned an error instead of a valid response: " +
              finalErrorState.message,
          );
        }
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
