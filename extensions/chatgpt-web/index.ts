import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ChatGptBrowserBackend } from "../../src/browser-backend.js";
import {
  applyRuntimeConfigPatch,
  loadRuntimeConfig,
  persistentConfigPath,
  resetComposerInsertMode,
  resetSubagentLimit,
  tunnelConfigured,
} from "../../src/config.js";
import { createMcpServer, type McpServerHandle } from "../../src/mcp-server.js";
import { WebModelProvider } from "../../src/provider.js";
import { TurnBroker } from "../../src/turn-broker.js";
import { TunnelSupervisor } from "../../src/tunnel.js";
import {
  resolveSubagentRootKey,
  WebSubagentLimiter,
  type SubagentLimitStatus,
} from "../../src/subagent-limit.js";
import { getWebArgumentCompletions, parseWebCommand, WEB_HELP_TEXT } from "../../src/web-command.js";

const PROVIDER = "chatgpt-web";
const MODEL = "web";
const API = "chatgpt-web";
const LOCAL_SENTINEL_KEY = "omp-chatgpt-web-local-transport";

const sharedConfig = loadRuntimeConfig();
const sharedBroker = new TurnBroker({ schemaForTool: toolWireSchema });
const sharedBrowser = new ChatGptBrowserBackend();
const sharedTunnel = new TunnelSupervisor();
const sharedConversationOwners = new Map<string, number>();
const sharedSubagentLimiter = new WebSubagentLimiter();

type SubagentContext = {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getHeader(): { parentSession?: string } | null;
  };
};

function subagentRootKey(ctx: SubagentContext): string {
  const header = ctx.sessionManager.getHeader();
  return resolveSubagentRootKey({
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    parentSession: header?.parentSession,
  });
}

function formatSubagentLimit(status: SubagentLimitStatus): string {
  return status.unlimited
    ? "unlimited (used " + status.used + ")"
    : status.used + "/" + status.limit + " used";
}

let sharedMcp: McpServerHandle | undefined;
let sharedMcpStarting: Promise<McpServerHandle> | undefined;
let sharedTunnelStarting: Promise<ReturnType<TunnelSupervisor["status"]>> | undefined;
let sharedBindingCount = 0;
let sharedClosePromise: Promise<void> | undefined;

async function ensureSharedMcp(): Promise<McpServerHandle> {
  if (sharedMcp) return sharedMcp;
  if (!sharedMcpStarting) {
    sharedMcpStarting = createMcpServer({
      host: sharedConfig.mcpHost,
      port: sharedConfig.mcpPort,
      broker: sharedBroker,
    }).then(handle => {
      sharedMcp = handle;
      return handle;
    }).finally(() => {
      sharedMcpStarting = undefined;
    });
  }
  return await sharedMcpStarting;
}

async function startSharedTunnel(): Promise<ReturnType<TunnelSupervisor["status"]>> {
  const server = await ensureSharedMcp();
  const current = sharedTunnel.status(sharedConfig);
  if (current.running && current.ready) return current;

  if (!sharedTunnelStarting) {
    sharedTunnelStarting = sharedTunnel
      .start(sharedConfig, server.url)
      .finally(() => {
        sharedTunnelStarting = undefined;
      });
  }
  return await sharedTunnelStarting;
}

async function ensureSharedTransport(): Promise<void> {
  await ensureSharedMcp();
  if (tunnelConfigured(sharedConfig)) {
    await startSharedTunnel();
  }
}

const sharedProvider = new WebModelProvider({
  config: sharedConfig,
  broker: sharedBroker,
  browser: sharedBrowser,
  ensureTransport: ensureSharedTransport,
});

function retainSharedConversation(key: string): void {
  sharedConversationOwners.set(
    key,
    (sharedConversationOwners.get(key) ?? 0) + 1,
  );
}

async function releaseSharedConversation(key: string): Promise<void> {
  const owners = sharedConversationOwners.get(key) ?? 0;
  if (owners > 1) {
    sharedConversationOwners.set(key, owners - 1);
    return;
  }
  sharedConversationOwners.delete(key);
  await sharedBrowser.invalidateSession(key).catch(() => undefined);
}

async function closeSharedRuntimeIfUnused(): Promise<void> {
  if (sharedBindingCount !== 0) return;
  if (sharedClosePromise) return await sharedClosePromise;

  sharedClosePromise = (async () => {
    // Yield once so a replacement/rebound session can claim the shared runtime
    // before we tear it down.
    await Promise.resolve();
    if (sharedBindingCount !== 0) return;

    sharedBroker.abortAll();
    if (sharedTunnelStarting) {
      await sharedTunnelStarting.catch(() => undefined);
    }
    await Promise.allSettled([
      sharedBrowser.close(),
      sharedTunnel.stop(sharedConfig),
      sharedMcp?.close() ?? Promise.resolve(),
    ]);
    sharedMcp = undefined;
    sharedConversationOwners.clear();
    sharedSubagentLimiter.clearAll();
  })().finally(() => {
    sharedClosePromise = undefined;
  });

  await sharedClosePromise;
}

export default function chatGptWebExtension(pi: ExtensionAPI) {
  const config = sharedConfig;
  const broker = sharedBroker;
  const browser = sharedBrowser;
  const tunnel = sharedTunnel;
  const ownedConversations = new Set<string>();
  const ownedRequests = new Set<string>();
  let bindingStarted = false;
  let bindingReleased = false;
  let bindingRootKey: string | undefined;

  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1/omp-chatgpt-web",
    apiKey: LOCAL_SENTINEL_KEY,
    api: API,
    streamSimple: (model, context, options) => {
      const request =
        options?.sessionId?.trim() ||
        options?.promptCacheKey?.trim();
      const conversation =
        options?.promptCacheKey?.trim() ||
        options?.sessionId?.trim();

      if (request) ownedRequests.add(request);
      if (conversation && !ownedConversations.has(conversation)) {
        ownedConversations.add(conversation);
        retainSharedConversation(conversation);
      }

      return sharedProvider.streamSimple(model, context, options);
    },
    models: [{
      id: MODEL,
      name: "ChatGPT Web",
      api: API,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 120_000,
      maxTokens: 32_000,
      preferWebsockets: false,
    }],
  });

  pi.registerCommand("web", {
    description: "ChatGPT Web: start | use | open | status | tunnel | config | set | unset | help",
    getArgumentCompletions: getWebArgumentCompletions,
    handler: async (args, ctx) => {
      try {
        const command = parseWebCommand(args);

        const showConfig = () => {
          const maskedApi = config.tunnelApiKey
            ? config.tunnelApiKey.slice(0, Math.min(5, config.tunnelApiKey.length)) + "..." +
              config.tunnelApiKey.slice(-4)
            : "(not set)";
          ctx.ui.notify(
            [
              "OMP ChatGPT Web config",
              "file: " + persistentConfigPath(),
              "tunnel: " + (config.tunnelId || "(not set)"),
              "api: " + maskedApi,
              "connector: " + config.connectorName,
              "browser: " + (config.browserExecutable || "(auto)"),
              "tunnel-client: " + config.tunnelClientBin,
              "cdp: " + config.browserCdpPort,
              "subagents: " + (config.subagentLimit < 0 ? "unlimited" : config.subagentLimit),
              "insert: " + config.insertMode,
            ].join("\n"),
            "info",
          );
        };

        const useWebModel = async () => {
          const model = ctx.models.resolve(PROVIDER + "/" + MODEL);
          if (!model) {
            ctx.ui.notify("chatgpt-web/web is not available in the current model registry.", "error");
            return false;
          }
          const changed = await pi.setModel(model);
          ctx.ui.notify(
            changed
              ? "OMP model backend -> chatgpt-web/web"
              : "Could not switch the OMP model to chatgpt-web/web.",
            changed ? "info" : "error",
          );
          return changed;
        };

        const showStatus = async () => {
          const server = await ensureSharedMcp();
          const browserStatus = await browser.status(config);
          const tunnelStatus = tunnel.status(config);
          const subagentStatus = sharedSubagentLimiter.status(subagentRootKey(ctx), config.subagentLimit);
          ctx.ui.notify(
            [
              "OMP ChatGPT Web provider",
              "model: " + PROVIDER + "/" + MODEL,
              "inference: chatgpt.com browser only",
              "MCP: " + server.url,
              "connector: " + config.connectorName,
              "tunnel: " + (tunnelStatus.running
                ? tunnelStatus.ready ? "ready" : "running/not-ready"
                : tunnelStatus.configured
                  ? "configured/stopped"
                  : "externally managed or unconfigured"),
              "browser: " + (browserStatus.open ? "open" : "closed"),
              "automation: " + (browserStatus.attached ? "attached over CDP" : "not attached"),
              "tabs: " + browserStatus.tabs,
              "retained sessions: " + browserStatus.retainedSessions,
              "active Web turns: " + browserStatus.activeTurns,
              "pending compactions: " + browserStatus.pendingCompactions,
              "shared Web sessions: " + sharedBindingCount,
              "subagents: " + formatSubagentLimit(subagentStatus),
              "insert strategy: " + config.insertMode,
              ...(browserStatus.lastPreparation
                ? [
                    "last prompt chars: " + browserStatus.lastPreparation.promptChars,
                    "prep ms: session=" + browserStatus.lastPreparation.sessionMs +
                      " mention=" + browserStatus.lastPreparation.mentionMs +
                      " insert=" + browserStatus.lastPreparation.insertMs +
                      " (mode=" + browserStatus.lastPreparation.insertMode +
                      " edit=" + browserStatus.lastPreparation.insertEditMs +
                      " verify=" + browserStatus.lastPreparation.insertVerifyMs + ")" +
                      " submit=" + browserStatus.lastPreparation.submitMs,
                  ]
                : []),
            ].join("\n"),
            "info",
          );
        };

        const manageTunnel = async (action: "start" | "stop" | "restart" | "status") => {
          const server = await ensureSharedMcp();
          if (action === "stop") {
            await tunnel.stop(config);
            ctx.ui.notify("Secure MCP Tunnel stopped", "info");
            return;
          }
          if (action === "restart") {
            await tunnel.stop(config);
            const status = await startSharedTunnel();
            ctx.ui.notify(
              "Secure MCP Tunnel restarted" +
                (status.pid ? " pid=" + status.pid : "") +
                (status.healthUrl ? "\nhealth: " + status.healthUrl : ""),
              "info",
            );
            return;
          }
          if (action === "start") {
            const status = await startSharedTunnel();
            ctx.ui.notify(
              "Secure MCP Tunnel ready" +
                (status.pid ? " pid=" + status.pid : "") +
                (status.healthUrl ? "\nhealth: " + status.healthUrl : ""),
              "info",
            );
            return;
          }
          const diagnostics = await tunnel.diagnostics(config);
          ctx.ui.notify(
            JSON.stringify(
              {
                ...diagnostics,
                mcp: server.url,
                mcpTrace: server.trace(),
              },
              null,
              2,
            ),
            diagnostics.ready ? "info" : "warning",
          );
        };

        if (command.kind === "help") {
          ctx.ui.notify(WEB_HELP_TEXT, "info");
          return;
        }
        if (command.kind === "invalid") {
          ctx.ui.notify(command.message, "warning");
          return;
        }
        if (command.kind === "start") {
          await ensureSharedTransport();
          await useWebModel();
          return;
        }
        if (command.kind === "use") {
          await useWebModel();
          return;
        }
        if (command.kind === "open") {
          await browser.openLogin(config);
          ctx.ui.notify(
            "Browser profile opened. Sign in to ChatGPT and verify the connector, then close that browser window before using the Web provider.",
            "info",
          );
          return;
        }
        if (command.kind === "status") {
          await showStatus();
          return;
        }
        if (command.kind === "config") {
          showConfig();
          return;
        }
        if (command.kind === "limit") {
          if (command.value === "default") {
            resetSubagentLimit(config);
          } else if (typeof command.value === "number") {
            applyRuntimeConfigPatch(config, { subagentLimit: command.value });
          }
          const status = sharedSubagentLimiter.status(subagentRootKey(ctx), config.subagentLimit);
          ctx.ui.notify(
            "Web subagent limit: " + formatSubagentLimit(status) +
              (command.value === undefined ? "" : "\nSaved for future OMP sessions."),
            "info",
          );
          return;
        }
        if (command.kind === "tunnel") {
          await manageTunnel(command.action);
          return;
        }
        if (command.kind === "unset") {
          const key = command.key;
          if (key === "api") {
            applyRuntimeConfigPatch(config, { tunnelApiKey: "" });
          } else if (key === "tunnel") {
            applyRuntimeConfigPatch(config, { tunnelId: "" });
          } else if (key === "connector") {
            applyRuntimeConfigPatch(config, { connectorName: "" });
          } else if (key === "browser") {
            applyRuntimeConfigPatch(config, { browserExecutable: "" });
          } else if (key === "subagents") {
            resetSubagentLimit(config);
          } else if (key === "insert") {
            resetComposerInsertMode(config);
          } else {
            applyRuntimeConfigPatch(config, { tunnelClientBin: "" });
          }
          if (key === "api" || key === "tunnel" || key === "tunnel-bin") {
            await tunnel.stop(config).catch(() => undefined);
          }
          ctx.ui.notify("Cleared web config: " + key, "info");
          return;
        }

        const { key, value } = command;
        if (key === "tunnel") {
          applyRuntimeConfigPatch(config, { tunnelId: value });
          await tunnel.stop(config).catch(() => undefined);
          ctx.ui.notify("Saved Secure MCP Tunnel ID.", "info");
          return;
        }
        if (key === "api") {
          applyRuntimeConfigPatch(config, { tunnelApiKey: value });
          await tunnel.stop(config).catch(() => undefined);
          ctx.ui.notify("Saved Secure MCP Tunnel runtime API key.", "info");
          return;
        }
        if (key === "tunnel-bin") {
          applyRuntimeConfigPatch(config, { tunnelClientBin: value });
          await tunnel.stop(config).catch(() => undefined);
          ctx.ui.notify("Saved tunnel-client executable: " + value, "info");
          return;
        }
        if (key === "connector") {
          applyRuntimeConfigPatch(config, { connectorName: value });
          ctx.ui.notify('Saved ChatGPT connector name: "' + value + '"', "info");
          return;
        }
        if (key === "browser") {
          applyRuntimeConfigPatch(config, { browserExecutable: value });
          ctx.ui.notify("Saved browser executable path.", "info");
          return;
        }
        if (key === "insert") {
          const mode = value.trim().toLowerCase();
          if (mode !== "default" && mode !== "lexical") {
            ctx.ui.notify("Insert mode must be 'default' or 'lexical'.", "warning");
            return;
          }
          applyRuntimeConfigPatch(config, { insertMode: mode });
          ctx.ui.notify("Saved ChatGPT composer insert mode: " + mode, "info");
          return;
        }
        if (key === "subagents") {
          const limit = value.toLowerCase() === "off" ? -1 : Number(value);
          if (!Number.isSafeInteger(limit) || limit < -1) {
            ctx.ui.notify("Subagent limit must be a non-negative integer or 'off'.", "warning");
            return;
          }
          applyRuntimeConfigPatch(config, { subagentLimit: limit });
          ctx.ui.notify(
            "Saved Web subagent limit: " + (limit < 0 ? "unlimited" : limit),
            "info",
          );
          return;
        }

        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          ctx.ui.notify("CDP port must be an integer from 1 to 65535.", "warning");
          return;
        }
        applyRuntimeConfigPatch(config, { browserCdpPort: port });
        ctx.ui.notify("Saved Chrome CDP port: " + port, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("web-config", {
    description: "Persist ChatGPT Web settings: show | tunnel <id> | api <key> | tunnel-bin <path> | connector <name> | browser <path> | cdp <port> | subagents <count|off> | insert <default|lexical> | clear <key>",
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        const firstSpace = trimmed.indexOf(" ");
        const action = (firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed).toLowerCase();
        const value = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "";

        const show = () => {
          const maskedApi = config.tunnelApiKey
            ? config.tunnelApiKey.slice(0, Math.min(5, config.tunnelApiKey.length)) + "..." +
              config.tunnelApiKey.slice(-4)
            : "(not set)";
          ctx.ui.notify(
            [
              "OMP ChatGPT Web config",
              "file: " + persistentConfigPath(),
              "tunnel: " + (config.tunnelId || "(not set)"),
              "api: " + maskedApi,
              "connector: " + config.connectorName,
              "browser: " + (config.browserExecutable || "(auto)"),
              "tunnel-client: " + config.tunnelClientBin,
              "cdp: " + config.browserCdpPort,
              "subagents: " + (config.subagentLimit < 0 ? "unlimited" : config.subagentLimit),
              "insert: " + config.insertMode,
            ].join("\n"),
            "info",
          );
        };

        if (!action || action === "show") {
          show();
          return;
        }

        if (action === "clear") {
          const key = value.toLowerCase();
          if (key === "api") {
            applyRuntimeConfigPatch(config, { tunnelApiKey: "" });
          } else if (key === "tunnel") {
            applyRuntimeConfigPatch(config, { tunnelId: "" });
          } else if (key === "connector") {
            applyRuntimeConfigPatch(config, { connectorName: "" });
          } else if (key === "browser") {
            applyRuntimeConfigPatch(config, { browserExecutable: "" });
          } else if (key === "tunnel-bin") {
            applyRuntimeConfigPatch(config, { tunnelClientBin: "" });
          } else if (key === "subagents") {
            resetSubagentLimit(config);
          } else if (key === "insert") {
            resetComposerInsertMode(config);
          } else {
            ctx.ui.notify("Usage: /web-config clear api|tunnel|tunnel-bin|connector|browser|subagents|insert", "warning");
            return;
          }
          if (key === "api" || key === "tunnel") {
            await tunnel.stop(config).catch(() => undefined);
          }
          ctx.ui.notify("Cleared web config: " + key, "info");
          return;
        }

        if (!value) {
          ctx.ui.notify(
            "Usage: /web-config show | tunnel <id> | api <key> | tunnel-bin <path> | connector <name> | browser <path> | cdp <port> | subagents <count|off> | insert <default|lexical> | clear <key>",
            "warning",
          );
          return;
        }

        if (action === "tunnel") {
          applyRuntimeConfigPatch(config, { tunnelId: value });
          await tunnel.stop(config).catch(() => undefined);
          ctx.ui.notify("Saved Secure MCP Tunnel ID.", "info");
          return;
        }

        if (action === "api") {
          applyRuntimeConfigPatch(config, { tunnelApiKey: value });
          await tunnel.stop(config).catch(() => undefined);
          ctx.ui.notify("Saved Secure MCP Tunnel runtime API key.", "info");
          return;
        }

        if (action === "tunnel-bin") {
          applyRuntimeConfigPatch(config, { tunnelClientBin: value });
          await tunnel.stop(config).catch(() => undefined);
          ctx.ui.notify("Saved tunnel-client executable: " + value, "info");
          return;
        }

        if (action === "connector") {
          applyRuntimeConfigPatch(config, { connectorName: value });
          ctx.ui.notify('Saved ChatGPT connector name: "' + value + '"', "info");
          return;
        }

        if (action === "browser") {
          applyRuntimeConfigPatch(config, { browserExecutable: value });
          ctx.ui.notify("Saved browser executable path.", "info");
          return;
        }

        if (action === "insert") {
          const mode = value.trim().toLowerCase();
          if (mode !== "default" && mode !== "lexical") {
            ctx.ui.notify("Insert mode must be 'default' or 'lexical'.", "warning");
            return;
          }
          applyRuntimeConfigPatch(config, { insertMode: mode });
          ctx.ui.notify("Saved ChatGPT composer insert mode: " + mode, "info");
          return;
        }

        if (action === "subagents") {
          const limit = value.toLowerCase() === "off" ? -1 : Number(value);
          if (!Number.isSafeInteger(limit) || limit < -1) {
            ctx.ui.notify("Subagent limit must be a non-negative integer or 'off'.", "warning");
            return;
          }
          applyRuntimeConfigPatch(config, { subagentLimit: limit });
          ctx.ui.notify("Saved Web subagent limit: " + (limit < 0 ? "unlimited" : limit), "info");
          return;
        }

        if (action === "cdp") {
          const port = Number(value);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            ctx.ui.notify("CDP port must be an integer from 1 to 65535.", "warning");
            return;
          }
          applyRuntimeConfigPatch(config, { browserCdpPort: port });
          ctx.ui.notify("Saved Chrome CDP port: " + port, "info");
          return;
        }

        ctx.ui.notify(
          "Unknown web-config key. Use: show | tunnel | api | tunnel-bin | connector | browser | cdp | subagents | insert | clear",
          "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("web-open", {
    description: "Open the persistent ChatGPT Web browser profile for sign-in and connector setup",
    handler: async (_args, ctx) => {
      try {
        await browser.openLogin(config);
        ctx.ui.notify(
          'Ordinary Chrome opened with the dedicated OMP profile and no automation/debugging flags. Sign in to ChatGPT, then CLOSE that Chrome window completely. The first Web-model turn will reopen the same profile and attach over CDP.',
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("web-use", {
    description: "Switch the current OMP session model to chatgpt-web/web",
    handler: async (_args, ctx) => {
      const model = ctx.models.resolve(PROVIDER + "/" + MODEL);
      if (!model) {
        ctx.ui.notify("chatgpt-web/web is not available in the current model registry.", "error");
        return;
      }
      const changed = await pi.setModel(model);
      ctx.ui.notify(
        changed
          ? "OMP model backend -> chatgpt-web/web"
          : "Could not switch the OMP model to chatgpt-web/web.",
        changed ? "info" : "error",
      );
    },
  });

  pi.registerCommand("web-status", {
    description: "Show ChatGPT Web provider, MCP, browser, and tunnel status",
    handler: async (_args, ctx) => {
      try {
        const server = await ensureSharedMcp();
        const browserStatus = await browser.status(config);
        const tunnelStatus = tunnel.status(config);
        ctx.ui.notify(
          [
            "OMP ChatGPT Web provider",
            "model: " + PROVIDER + "/" + MODEL,
            "inference: chatgpt.com browser only",
            "MCP: " + server.url,
            "connector: " + config.connectorName,
            "tunnel: " + (tunnelStatus.running
              ? tunnelStatus.ready ? "ready" : "running/not-ready"
              : tunnelStatus.configured
                ? "configured/stopped"
                : "externally managed or unconfigured"),
            "browser: " + (browserStatus.open ? "open" : "closed"),
            "automation: " + (browserStatus.attached ? "attached over CDP" : "not attached"),
            "tabs: " + browserStatus.tabs,
            "retained sessions: " + browserStatus.retainedSessions,
            "active Web turns: " + browserStatus.activeTurns,
            "pending compactions: " + browserStatus.pendingCompactions,
            "shared Web sessions: " + sharedBindingCount,
            "insert strategy: " + config.insertMode,
            ...(browserStatus.lastPreparation
              ? [
                  "last prompt chars: " + browserStatus.lastPreparation.promptChars,
                  "prep ms: session=" + browserStatus.lastPreparation.sessionMs +
                    " mention=" + browserStatus.lastPreparation.mentionMs +
                    " insert=" + browserStatus.lastPreparation.insertMs +
                    " (mode=" + browserStatus.lastPreparation.insertMode +
                    " edit=" + browserStatus.lastPreparation.insertEditMs +
                    " verify=" + browserStatus.lastPreparation.insertVerifyMs + ")" +
                    " submit=" + browserStatus.lastPreparation.submitMs,
                ]
              : []),
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("web-tunnel", {
    description: "Manage OpenAI Secure MCP Tunnel: start | stop | status",
    handler: async (args, ctx) => {
      try {
        const action = args.trim().toLowerCase() || "status";
        const server = await ensureSharedMcp();
        if (action === "start") {
          const status = await startSharedTunnel();
          ctx.ui.notify(
            "Secure MCP Tunnel ready" +
              (status.pid ? " pid=" + status.pid : "") +
              (status.healthUrl ? "\nhealth: " + status.healthUrl : ""),
            "info",
          );
          return;
        }
        if (action === "stop") {
          await tunnel.stop(config);
          ctx.ui.notify("Secure MCP Tunnel stopped", "info");
          return;
        }
        if (action !== "status") {
          ctx.ui.notify("Usage: /web-tunnel start|stop|status", "warning");
          return;
        }
        const diagnostics = await tunnel.diagnostics(config);
        ctx.ui.notify(
          JSON.stringify(
            {
              ...diagnostics,
              mcp: server.url,
              mcpTrace: server.trace(),
            },
            null,
            2,
          ),
          diagnostics.ready ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const current = ctx.models.current() ?? ctx.model;
    if (current?.provider !== PROVIDER || current.id !== MODEL) return;

    const rootKey = bindingRootKey ?? subagentRootKey(ctx);
    const decision = sharedSubagentLimiter.trySpawn(rootKey, event.spawnKey, config.subagentLimit);
    if (!decision.allowed) {
      return {
        block: true,
        reason:
          "ChatGPT Web subagent hard limit reached (" + decision.used + "/" + decision.limit + "). " +
          "Use /web limit <N> to raise it, /web limit 0 to block all, or /web limit off for unlimited.",
      };
    }

    return {
      model: PROVIDER + "/" + MODEL,
      note:
        "OMP ChatGPT Web routes this subagent through the same shared Web runtime " +
        "with an independent ChatGPT Temporary Chat tab. Subagent budget: " +
        formatSubagentLimit(decision) + ".",
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!bindingStarted) {
      bindingStarted = true;
      sharedBindingCount += 1;
      bindingRootKey = subagentRootKey(ctx);
      sharedSubagentLimiter.retain(bindingRootKey);
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "omp-chatgpt-web",
        ctx.ui.theme.fg("accent", "web-backend"),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (bindingReleased) return;
    bindingReleased = true;

    for (const request of ownedRequests) broker.end(request);
    ownedRequests.clear();

    await Promise.allSettled(
      [...ownedConversations].map(key => releaseSharedConversation(key)),
    );
    ownedConversations.clear();

    if (bindingStarted) {
      sharedBindingCount = Math.max(0, sharedBindingCount - 1);
      if (bindingRootKey) sharedSubagentLimiter.release(bindingRootKey);
    }
    await closeSharedRuntimeIfUnused();
  });
}
