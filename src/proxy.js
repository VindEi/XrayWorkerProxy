export async function handleProxyRequest(request, config) {
  const url = new URL(request.url);
  const targets = [config.primaryHost];
  if (config.backupHost) targets.push(config.backupHost);

  const clientIP = request.headers.get("cf-connecting-ip");
  const isWebSocketUpgrade =
    (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";

  // Non-WS headers: full clone + sanitize, as before.
  const modifiedHeaders = new Headers(request.headers);
  if (clientIP) {
    modifiedHeaders.set("X-Forwarded-For", clientIP);
    modifiedHeaders.set("X-Real-IP", clientIP);
  }
  const headersToRemove = [
    "cf-ray",
    "cf-visitor",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-worker",
    "x-proxy-auth",
  ];
  headersToRemove.forEach((h) => modifiedHeaders.delete(h));

  for (let i = 0; i < targets.length; i++) {
    const currentHost = targets[i];
    const targetUrl = `${config.scheme}://${currentHost}:${config.targetPort}${url.pathname}${url.search}`;

    let fetchOptions;

    if (isWebSocketUpgrade) {
      // Cloudflare's documented WS-over-fetch pattern uses a minimal
      // header set (Host + Upgrade: websocket) and lets the Workers
      // runtime generate Sec-WebSocket-Key etc. itself for THIS outbound
      // leg. Forwarding the client's original Sec-WebSocket-Key /
      // Connection / Sec-WebSocket-Version headers verbatim — which
      // belong to a *different* handshake (client<->edge) — appears to
      // break the runtime's automatic upgrade detection on the outbound
      // fetch, which is the likely cause of the hang/timeout.
      const wsHeaders = new Headers();
      wsHeaders.set("Host", currentHost);
      wsHeaders.set("Upgrade", "websocket");
      if (clientIP) {
        wsHeaders.set("X-Forwarded-For", clientIP);
        wsHeaders.set("X-Real-IP", clientIP);
      }
      fetchOptions = {
        headers: wsHeaders,
        cf: { cacheTtl: 0, cacheEverything: false },
      };
    } else {
      modifiedHeaders.set("Host", currentHost);
      fetchOptions = {
        method: request.method,
        headers: modifiedHeaders,
        redirect: "manual",
        cf: { cacheTtl: 0, cacheEverything: false },
      };

      // Only attach a timeout if one was explicitly configured (> 0).
      // Long-lived XHTTP/WS streams must NOT be subject to a short fetch
      // timeout, or they'll be killed mid-stream.
      if (config.timeoutMs > 0) {
        fetchOptions.signal = AbortSignal.timeout(config.timeoutMs);
      }

      if (
        !["GET", "HEAD"].includes(request.method.toUpperCase()) &&
        request.body
      ) {
        fetchOptions.body = request.body;
        fetchOptions.duplex = "half";
      }
    }

    try {
      const response = await fetch(targetUrl, fetchOptions);

      // Auto-failover on 502/503/504
      if ([502, 503, 504].includes(response.status) && i < targets.length - 1) {
        console.warn(
          `[FAILOVER] ${currentHost} returned ${response.status}, trying backup`,
        );
        continue;
      }

      // WebSocket / HTTPUpgrade 101 passthrough.
      if (response.status === 101) {
        const webSocket = response.webSocket;
        if (!webSocket) {
          console.error(
            `[WS ERROR] ${currentHost} returned 101 without a webSocket`,
          );
          return new Response("Bad Gateway", { status: 502 });
        }
        webSocket.accept();
        return new Response(null, { status: 101, webSocket });
      }

      const respHeaders = sanitizeResponseHeaders(response.headers, targets);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      console.error(`[FETCH ERROR] ${currentHost}: ${err.message}`);
      if (i === targets.length - 1) {
        return new Response("Not Found", { status: 404 });
      }
      // otherwise fall through to try the next target
    }
  }

  return new Response("Not Found", { status: 404 });
}

function sanitizeResponseHeaders(headers, backendHosts) {
  const h = new Headers(headers);
  h.delete("content-encoding");
  h.delete("content-length");
  h.delete("server");
  h.delete("via");
  h.delete("x-powered-by");

  const location = h.get("location");
  if (location) {
    const revealsBackend = backendHosts.some((host) => location.includes(host));
    if (revealsBackend || /^https?:\/\//i.test(location)) {
      h.delete("location");
    }
  }

  return h;
}
