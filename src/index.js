import { loadConfig } from "./config.js";
import { serveDecoy } from "./decoy.js";
import { handleProxyRequest } from "./proxy.js";
import { safeEqual, pathMatchesGate } from "./util.js";

export default {
  async fetch(request, env, ctx) {
    const config = loadConfig(env);
    const url = new URL(request.url);

    // Gate 1: Path check — evaluated first and unconditionally, before we
    // even look at whether TARGET_HOST is configured. That way a missing
    // secret can never make the worker behave *differently* for someone
    // who isn't hitting the exact gate path — everyone else always gets
    // the same decoy, misconfigured or not.
    if (!pathMatchesGate(url.pathname, config.proxyPath)) {
      return serveDecoy();
    }

    // Gate 2: Access Token check (optional)
    if (config.accessToken) {
      const presented = request.headers.get("X-Proxy-Auth") || "";
      if (!safeEqual(presented, config.accessToken)) {
        return serveDecoy();
      }
    }

    // Gate 3: Rate limit (optional). No-ops unless RATE_LIMIT_ENABLED=true
    // AND a RATE_LIMITER binding is configured in wrangler.toml — see the
    // wrangler.toml snippet in the setup notes.
    if (config.rateLimitEnabled && env.RATE_LIMITER) {
      const key = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) {
        // Same decoy as every other rejection. No 429, no distinguishing
        // signal — an active prober sees "Coming Soon" either way.
        return serveDecoy();
      }
    }

    if (!config.primaryHost) {
      // TARGET_HOST secret missing entirely — fail closed, but still look
      // like the decoy to anyone hitting the URL. Only you see this line,
      // in the Workers dashboard logs.
      console.error("[CONFIG] TARGET_HOST is unset — check secrets");
      return serveDecoy();
    }

    return await handleProxyRequest(request, config);
  },
};
