import { spawn } from "node:child_process";

function send(child: ReturnType<typeof spawn>, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) return;
      cleanup();
      resolve(JSON.parse(line));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("error", onError);
    };

    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.stdin?.write(`${JSON.stringify(request)}\n`);
  });
}

const command = process.execPath;
const script = "dist/mcp/tunnel-mock.js";

const child = spawn(command, [script], {
  stdio: ["pipe", "pipe", "inherit"],
});

const initialize = await send(child, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
});

if (initialize.error) throw new Error(initialize.error.message);

const tools = await send(child, {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
});

if (!tools.result?.tools?.some((tool: { name: string }) => tool.name === "read")) {
  throw new Error("read tool missing from tunnel");
}

child.kill();
console.log("MCP tunnel stdio smoke: PASS");
