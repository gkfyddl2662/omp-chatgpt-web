import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ChatGptBrowserBackend } from "../../src/browser-backend.js";
import {
  applyRuntimeConfigPatch,
  loadRuntimeConfig,
  persistentConfigPath,
  tunnelConfigured,
} from "../../src/config.js";
import { createMcpServer, type McpServerHandle } from "../../src/mcp-server.js";
import { WebModelProvider } from "../../src/provider.js";
import { TurnBroker } from "../../src/turn-broker.js";
import { TunnelSupervisor } from "../../src/tunnel.js";

const PROVIDER = "chatgpt-web";
const MODEL = "web";
const API = "chatgpt-web";
const LOCAL_SENTINEL_KEY = "omp-chatgpt-web-local-transport";

export default function chatGptWebExtension(pi: ExtensionAPI) {
  const config = loadRuntimeConfig();
  const broker = new TurnBroker();
  const browser = new ChatGptBrowserBackend();
  const tunnel = new TunnelSupervisor();
  let mcp: McpServerHandle | undefined;
  let mcpStarting: Promise<McpServerHandle> | undefined;

  async function ensureMcp(): Promise<McpServerHandle> {
    if (mcp) return mcp;
    if (!mcpStarting) {
      mcpStarting = createMcpServer({
        host: config.mcpHost,
        port: config.mcpPort,
        broker,
      }).then(handle => {
        mcp = handle;
        return handle;
      }).finally(() => {
        mcpStarting = undefined;
      });
    }
    return await mcpStarting;
  }

  async function ensureTransport(): Promise<void> {
    const server = await ensureMcp();
    const status = tunnel.status(config);
    if (status.running) return;
    if (tunnelConfigured(config)) {
      await tunnel.start(config, server.url);
    }
  }

  const provider = new WebModelProvider({
    config,
    broker,
    browser,
    ensureTransport,
  });

  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1/omp-chatgpt-web",
    apiKey: LOCAL_SENTINEL_KEY,
    api: API,
    streamSimple: provider.streamSimple,
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

  pi.registerCommand("web-config", {
    description: "Persist ChatGPT Web settings: show | tunnel <id> | api <key> | connector <name> | browser <path> | cdp <port> | clear <key>",
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
              "cdp: " + config.browserCdpPort,
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
          } else {
            ctx.ui.notify("Usage: /web-config clear api|tunnel|connector|browser", "warning");
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
            "Usage: /web-config show | tunnel <id> | api <key> | connector <name> | browser <path> | cdp <port> | clear <key>",
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
          "Unknown web-config key. Use: show | tunnel | api | connector | browser | cdp | clear",
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
        const server = await ensureMcp();
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
            "active Web turns: " + browserStatus.activeTurns,
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
        const server = await ensureMcp();
        if (action === "start") {
          const status = await tunnel.start(config, server.url);
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
          JSON.stringify({ ...diagnostics, mcp: server.url }, null, 2),
          diagnostics.ready ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("omp-chatgpt-web", ctx.ui.theme.fg("accent", "web-backend"));
  });

  pi.on("session_shutdown", async () => {
    broker.abortAll();
    await Promise.allSettled([
      browser.close(),
      tunnel.stop(config),
      mcp?.close() ?? Promise.resolve(),
    ]);
    mcp = undefined;
  });
}
