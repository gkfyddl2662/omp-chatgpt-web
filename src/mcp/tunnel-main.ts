import { startSecureMcpTunnel } from "./tunnel-launcher.js";

try {
  const { process, config } = startSecureMcpTunnel();

  console.error(`Secure MCP Tunnel starting: ${config.command}`);

  process.on("exit", (code) => {
    console.error(`Secure MCP Tunnel exited: ${code}`);
  });
} catch (error) {
  console.error(
    `Secure MCP Tunnel startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
