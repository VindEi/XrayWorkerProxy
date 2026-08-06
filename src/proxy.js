export async function handleProxyRequest(request, config) {
  const url = new URL(request.url);
  const targets = [config.primaryHost];
  if (config.backupHost) targets.push(config.backupHost);

  // Sanitize headers
  const modifiedHeaders = new Headers(request.headers);
  const clientIP = request.headers.get("cf-connecting-ip");
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
    modifiedHeaders.set("Host", currentHost);

    const targetUrl = `${config.scheme}://${currentHost}:${config.targetPort}${url.pathname}${url.search}`;

    const fetchOptions = {
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

    try {
      const response = await fetch(targetUrl, fetchOptions);

      // Auto-failover on 502/503/504
      if ([502, 503, 504].includes(response.status) && i < targets.length - 1) {
        console.warn(
          `[FAILOVER] ${currentHost} returned ${response.status}, trying backup`,
        );
        continue;
      }

      // WebSocket / HTTPUpgrade 101 passthrough
      if (response.status === 101) {
        return response;
      }

      // fetch() transparently decompresses gzip/br bodies but leaves the
      // original content-encoding/content-length headers intact — strip
      // them or the client will misinterpret the (already-decoded) body.
      const respHeaders = new Headers(response.headers);
      respHeaders.delete("content-encoding");
      respHeaders.delete("content-length");

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
