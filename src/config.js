export function loadConfig(env) {
  return {
    primaryHost: env.TARGET_HOST || "",
    backupHost: env.BACKUP_HOST || "",
    targetPort: env.TARGET_PORT || "8443",
    scheme: env.SCHEME || "https",
    proxyPath: env.PROXY_PATH || "/path_",
    accessToken: env.ACCESS_TOKEN || "",
    // 0 (or unset) disables the timeout entirely. XHTTP/WS connections are
    // meant to stay open for minutes (see xmux hMaxReusableSecs on the
    // Xray side) — a short fetch timeout here will silently kill live
    // streams mid-transfer and look exactly like "uplink sent, no downlink".
    timeoutMs: parseInt(env.FETCH_TIMEOUT_MS || "0", 10),
    // Opt-in only, off by default. If this is true but no RATE_LIMITER
    // binding exists in wrangler.toml, the check in index.js silently
    // no-ops — so flipping this on without also adding the binding is a
    // safe no-op, not a broken deploy.
    rateLimitEnabled:
      (env.RATE_LIMIT_ENABLED || "false").toLowerCase() === "true",
  };
}

