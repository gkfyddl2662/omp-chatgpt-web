export const WEB_CONFIG_KEYS = [
  "tunnel",
  "api",
  "tunnel-bin",
  "connector",
  "browser",
  "cdp",
  "subagents",
  "insert",
] as const;

export const WEB_CLEARABLE_KEYS = [
  "tunnel",
  "api",
  "tunnel-bin",
  "connector",
  "browser",
  "subagents",
  "insert",
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
  | { kind: "limit"; value?: number | "default" }
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
  { name: "status", description: "Show provider, browser, MCP, tunnel, and subagent status" },
  { name: "limit", description: "Show or set the per-root Web subagent hard cap", usage: "[N|off|default]" },
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
  "  /web status                show provider/browser/tunnel/subagent status",
  "  /web limit                 show the current subagent hard cap",
  "  /web limit 4               allow at most 4 Web subagents per root session",
  "  /web limit 0               block all Web subagents",
  "  /web limit off             disable the hard cap",
  "  /web limit default         restore the default cap",
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
  "  /web set subagents <count>",
  "  /web set insert default|editor   editor is the normal default; default bypasses direct-editor probing",
  "  /web unset tunnel|api|tunnel-bin|connector|browser|subagents|insert",
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
  if (head === "limit") {
    const value = tail.toLowerCase();
    if (!value) return { kind: "limit" };
    if (value === "off" || value === "unlimited") return { kind: "limit", value: -1 };
    if (value === "default" || value === "reset") return { kind: "limit", value: "default" };
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { kind: "invalid", message: "Usage: /web limit [non-negative integer|off|default]" };
    }
    return { kind: "limit", value: parsed };
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
        message: "Usage: /web set tunnel|api|tunnel-bin|connector|browser|cdp|subagents|insert <value>",
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
        message: "Usage: /web unset tunnel|api|tunnel-bin|connector|browser|subagents|insert",
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

  if (root === "limit" && !rest.trim().includes(" ")) {
    const normalized = rest.trim().toLowerCase();
    const items = [
      { name: "0", description: "Block all Web subagents" },
      { name: "1", description: "Allow 1 Web subagent per root session" },
      { name: "2", description: "Allow 2 Web subagents per root session" },
      { name: "4", description: "Allow 4 Web subagents per root session" },
      { name: "8", description: "Allow 8 Web subagents per root session" },
      { name: "off", description: "Disable the hard cap" },
      { name: "default", description: "Restore the default cap" },
    ];
    return filterCompletions(normalized, items, "limit ");
  }

  if (root === "tunnel" && !rest.trim().includes(" ")) {
    return filterCompletions(rest.trim(), TUNNEL_ACTIONS, "tunnel ");
  }

  if (root === "set") {
    const firstSpace = rest.indexOf(" ");
    if (firstSpace < 0) {
      const items = WEB_CONFIG_KEYS.map(name => ({
        name,
        description: "Set " + name,
        usage: "<value>",
      }));
      return filterCompletions(rest.trim(), items, "set ");
    }

    const key = rest.slice(0, firstSpace).trim().toLowerCase();
    const valuePrefix = rest.slice(firstSpace + 1).trim().toLowerCase();
    if (key === "insert" && !valuePrefix.includes(" ")) {
      return filterCompletions(
        valuePrefix,
        [
          { name: "default", description: "Bypass direct-editor probing and use execCommand/CDP" },
          { name: "editor", description: "Use the default ProseMirror/Lexical direct-editor path with fallback" },
        ],
        "set insert ",
      );
    }
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
