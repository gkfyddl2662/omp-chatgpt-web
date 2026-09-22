import { startSecureMcpTunnel } from "./tunnel-launcher.js";

const { process } = startSecureMcpTunnel();

process.on("exit", (code) => {
  console.error(`Secure MCP Tunnel exited: ${code}`);
});
