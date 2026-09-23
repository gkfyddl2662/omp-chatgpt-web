export const WEB_CONFIG_KEYS = [
  "tunnel",
  "api",
  "tunnel-bin",
  "connector",
  "browser",
  "cdp",
] as const;

export const WEB_CLEARABLE_KEYS = [
  "tunnel",
  "api",
  "tunnel-bin",
  "connector",
  "browser",
] as const;

export type WebConfigKey = (typeof WEB_CONFIG_KEYS)[number];
export type WebClearableKey = (typeof WEB_CLEARABLE_KEYS)[number];

export type WebCommand =
  | { kind: "help" }
  | { kind: "start" }
  | { kind: "use" }
  | { kind: "open" }
  | { kind: "status" }
  | { kind: "config" }
  | { kind: "tunnel"; action: "start" | "stop" | "restart" | "status" }
  | { kind: "set"; key: WebConfigKey; value: string }
  | { kind: "unset"; key: WebClearableKey }
  | { kind: "invalid"; message: string };

export interface WebCommandCompletion {
  label: string;
  value: string;
  description?: string;
  hint?: string;
}

const ROOT_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  usage?: string;
}> = [
  { name: "start", description: "Prepare the Web transport and switch to chatgpt-web/web" },
  { name: "use", description: "Switch the current session to chatgpt-web/web" },
  { name: "open", description: "Open the dedicated browser profile for sign-in" },
  { name: "status", description: "Show provider, browser, MCP, and tunnel status" },
  { name: "tunnel", description: "Start or manage the Secure MCP Tunnel", usage: "[start|stop|restart|status]" },
  { name: "config", description: "Show the saved ChatGPT Web configuration" },
  { name: "set", description: "Set a saved ChatGPT Web configuration value", usage: "<key> <value>" },
  { name: "unset", description: "Clear a saved ChatGPT Web configuration value", usage: "<key>" },
  { name: "help", description: "Show ChatGPT Web command help" },
];

const TUNNEL_ACTIONS = [
  { name: "start", description: "Ensure the Secure MCP Tunnel is running" },
  { name: "stop", description: "Stop the Secure MCP Tunnel" },
  { name: "restart", description: "Restart the Secure MCP Tunnel" },
  { name: "status", description: "Show Secure MCP Tunnel diagnostics" },
] as const;

export const WEB_HELP_TEXT = [
  "OMP ChatGPT Web",
  "",
  "Quick start:",
  "  /web start                 prepare transport + switch to chatgpt-web/web",
  "  /web use                   switch model only",
  "  /web open                  open the sign-in browser profile",
  "  /web status                show provider/browser/tunnel status",
  "",
  "Tunnel:",
  "  /web tunnel               start it (idempotent)",
  "  /web tunnel stop",
  "  /web tunnel restart",
  "  /web tunnel status",
  "",
  "Configuration:",
  "  /web config",
  "  /web set tunnel <id>",
  "  /web set api <key>",
  "  /web set tunnel-bin <path>",
  "  /web set connector <name>",
  "  /web set browser <path>",
  "  /web set cdp <port>",
  "  /web unset tunnel|api|tunnel-bin|connector|browser",
].join("\n");

function splitHead(raw: string): { head: string; tail: string } {
  const trimmed = raw.trim();
  const index = trimmed.indexOf(" ");
  if (index < 0) return { head: trimmed.toLowerCase(), tail: "" };
  return {
    head: trimmed.slice(0, index).toLowerCase(),
    tail: trimmed.slice(index + 1).trim(),
  };
}

function isConfigKey(value: string): value is WebConfigKey {
  return (WEB_CONFIG_KEYS as readonly string[]).includes(value);
}

function isClearableKey(value: string): value is WebClearableKey {
  return (WEB_CLEARABLE_KEYS as readonly string[]).includes(value);
}

export function parseWebCommand(raw: string): WebCommand {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "help" || trimmed === "?") return { kind: "help" };

  const { head, tail } = splitHead(trimmed);

  if (head === "start") {
    return tail ? { kind: "invalid", message: "Usage: /web start" } : { kind: "start" };
  }
  if (head === "use") {
    return tail ? { kind: "invalid", message: "Usage: /web use" } : { kind: "use" };
  }
  if (head === "open") {
    return tail ? { kind: "invalid", message: "Usage: /web open" } : { kind: "open" };
  }
  if (head === "status") {
    return tail ? { kind: "invalid", message: "Usage: /web status" } : { kind: "status" };
  }
  if (head === "config") {
    return tail ? { kind: "invalid", message: "Usage: /web config" } : { kind: "config" };
  }

  if (head === "tunnel") {
    const action = (tail || "start").toLowerCase();
    if (action === "on") return { kind: "tunnel", action: "start" };
    if (action === "off") return { kind: "tunnel", action: "stop" };
    if (action === "start" || action === "stop" || action === "restart" || action === "status") {
      return { kind: "tunnel", action };
    }
    return {
      kind: "invalid",
      message: "Usage: /web tunnel [start|stop|restart|status]",
    };
  }

  if (head === "set") {
    const { head: key, tail: value } = splitHead(tail);
    if (!key || !value) {
      return {
        kind: "invalid",
        message: "Usage: /web set tunnel|api|tunnel-bin|connector|browser|cdp <value>",
      };
    }
    if (!isConfigKey(key)) {
      return {
        kind: "invalid",
        message: "Unknown config key: " + key,
      };
    }
    return { kind: "set", key, value };
  }

  if (head === "unset") {
    const key = tail.toLowerCase();
    if (!key || key.includes(" ")) {
      return {
        kind: "invalid",
        message: "Usage: /web unset tunnel|api|tunnel-bin|connector|browser",
      };
    }
    if (!isClearableKey(key)) {
      return {
        kind: "invalid",
        message: "Unknown or non-clearable config key: " + key,
      };
    }
    return { kind: "unset", key };
  }

  return {
    kind: "invalid",
    message: "Unknown /web command: " + head + "\n\n" + WEB_HELP_TEXT,
  };
}

function filterCompletions(
  prefix: string,
  items: ReadonlyArray<{ name: string; description: string; usage?: string }>,
  valuePrefix = "",
): WebCommandCompletion[] | null {
  const normalized = prefix.toLowerCase();
  const matches = items
    .filter(item => item.name.startsWith(normalized))
    .map(item => ({
      label: item.name,
      value: valuePrefix + item.name + (item.usage ? " " : ""),
      description: item.description,
      hint: item.usage,
    }));
  return matches.length > 0 ? matches : null;
}

export function getWebArgumentCompletions(argumentPrefix: string): WebCommandCompletion[] | null {
  const firstSpace = argumentPrefix.indexOf(" ");
  if (firstSpace < 0) {
    return filterCompletions(argumentPrefix.trim(), ROOT_COMMANDS);
  }

  const root = argumentPrefix.slice(0, firstSpace).trim().toLowerCase();
  const rest = argumentPrefix.slice(firstSpace + 1);

  if (root === "tunnel" && !rest.trim().includes(" ")) {
    return filterCompletions(rest.trim(), TUNNEL_ACTIONS, "tunnel ");
  }

  if (root === "set" && !rest.trim().includes(" ")) {
    const items = WEB_CONFIG_KEYS.map(name => ({
      name,
      description: "Set " + name,
      usage: "<value>",
    }));
    return filterCompletions(rest.trim(), items, "set ");
  }

  if (root === "unset" && !rest.trim().includes(" ")) {
    const items = WEB_CLEARABLE_KEYS.map(name => ({
      name,
      description: "Clear " + name,
    }));
    return filterCompletions(rest.trim(), items, "unset ");
  }

  return null;
}
