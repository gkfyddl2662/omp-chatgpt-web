import { createTunnelConfigFromEnv } from "./tunnel-config.js";

const config = createTunnelConfigFromEnv();

console.log(JSON.stringify({
  tunnel: {
    idConfigured: Boolean(config.tunnelId),
    runtimeKeyConfigured: Boolean(config.runtimeKey),
    command: config.command,
  },
  status: "secure-tunnel-config-ok",
}, null, 2));
