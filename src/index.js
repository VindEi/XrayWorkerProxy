import { loadConfig } from "./config.js";
import { serveDecoy } from "./decoy.js";
import { handleProxyRequest } from "./proxy.js";

export default {
  async fetch(request, env, ctx) {
    const config = loadConfig(env);

    if (!config.primaryHost) {
      // TARGET_HOST secret missing entirely — fail closed rather than
      // proxying to a bogus/empty host.
      return new Response("Service Unavailable", { status: 503 });
    }

    const url = new URL(request.url);

    // Gate 1: Path check
    if (!url.pathname.startsWith(config.proxyPath)) {
      return serveDecoy();
    }

    // Gate 2: Access Token check (optional)
    if (config.accessToken) {
      const presented = request.headers.get("X-Proxy-Auth") || "";
      if (presented !== config.accessToken) {
        return serveDecoy();
      }
    }

    return await handleProxyRequest(request, config);
  },
};
