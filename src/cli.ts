import { ChatGptBrowserRuntime } from "./chatgpt-web/browser-runtime.js";

function usage(): never {
  console.error([
    "Usage:",
    "  node dist/cli.js browser-check",
    "  node dist/cli.js browser-login",
    "  node dist/cli.js chat <prompt>",
  ].join("\n"));
  process.exit(2);
}

const command = process.argv[2];
const runtime = new ChatGptBrowserRuntime();

try {
  if (command === "browser-check") {
    const authenticated = await runtime.checkAuthenticated();
    console.log(JSON.stringify({ authenticated, profileDir: runtime.profileDir }));
    process.exitCode = authenticated ? 0 : 3;
  } else if (command === "browser-login") {
    console.log("A managed Chrome/Edge window will open. Sign in to ChatGPT if needed.");
    console.log("Waiting for the normal ChatGPT composer...");
    await runtime.waitUntilAuthenticated();
    console.log("ChatGPT Web authentication: READY");
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
