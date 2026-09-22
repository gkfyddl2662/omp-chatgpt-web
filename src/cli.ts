import { ChatGptBrowserRuntime, BrowserSessionManager } from "./chatgpt-web/index.js";

function usage(): never {
  console.error([
    "Usage:",
    "  node dist/cli.js browser-check",
    "  node dist/cli.js browser-login",
    "  node dist/cli.js browser-setup",
    "  node dist/cli.js doctor",
    "  node dist/cli.js chat <prompt>",
  ].join("\n"));
  process.exit(2);
}

const command = process.argv[2];
const runtime = new ChatGptBrowserRuntime();
const sessions = new BrowserSessionManager();

try {
  if (command === "browser-check") {
    const authenticated = await runtime.checkAuthenticated();
    console.log(JSON.stringify({ authenticated, profileDir: runtime.profileDir, connectionMode: runtime.connectionMode }));
    process.exitCode = authenticated ? 0 : 3;
  } else if (command === "browser-login") {
    console.log(`Browser connection mode: ${runtime.connectionMode}`);
    await runtime.waitUntilAuthenticated();
    console.log("ChatGPT Web authentication: READY");
  } else if (command === "browser-setup") {
    await runtime.waitUntilAuthenticated();
    const state = await sessions.save(runtime.profileDir);
    console.log(JSON.stringify({ ready: true, state }, null, 2));
  } else if (command === "doctor") {
    const authenticated = await runtime.checkAuthenticated();
    const session = await sessions.doctor();
    console.log(JSON.stringify({
      backend: "chatgpt-web",
      authenticated,
      connectionMode: runtime.connectionMode,
      profileDir: runtime.profileDir,
      session,
    }, null, 2));
  } else if (command === "chat") {
    const prompt = process.argv.slice(3).join(" ").trim();
    if (!prompt) usage();
    const result = await runtime.runTurn({ prompt });
    console.log(result.text);
  } else {
    usage();
  }
} finally {
  await runtime.close().catch(() => {});
}
