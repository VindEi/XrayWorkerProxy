export async function handleProxyRequest(request, config) {
  const url = new URL(request.url);
  const targets = [config.primaryHost];
  if (config.backupHost) targets.push(config.backupHost);

  const clientIP = request.headers.get("cf-connecting-ip");
  const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
  const connectionHeader = (
    request.headers.get("Connection") || ""
  ).toLowerCase();
  const isWebSocketUpgrade =
    upgrade === "websocket" && connectionHeader.includes("upgrade");

  if (isWebSocketUpgrade) {
    return handleWebSocketUpgrade(request, url, targets, config, clientIP);
  }

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

    modifiedHeaders.set("Host", currentHost);
    const fetchOptions = {
      method: request.method,
      headers: modifiedHeaders,
      redirect: "manual",
      cf: { cacheTtl: 0, cacheEverything: false },
    };

    // Only attach a timeout if one was explicitly configured (> 0).
    // Long-lived XHTTP streams must NOT be subject to a short fetch
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

// --- WebSocket handling -----------------------------------------------
//
// IMPORTANT: a WebSocket obtained from an outbound fetch() to the backend
// (backendResponse.webSocket) is the Worker acting as a WS *client* to
// that backend. It is a different object from the WebSocketPair tied to
// the ORIGINAL inbound request. Handing the backend's socket straight
// back as the `webSocket` on the client-facing Response doesn't work
// reliably — instead, build a fresh WebSocketPair for the client leg,
// dial the backend as an independent connection, and explicitly relay
// messages between the two.

async function handleWebSocketUpgrade(request, url, targets, config, clientIP) {
  if (request.method.toUpperCase() !== "GET") {
    return new Response("ws upgrade requests must use GET.", { status: 400 });
  }

  const [clientSocket, workerSocket] = Object.values(new WebSocketPair());
  workerSocket.accept();

  const backendHeaders = new Headers(request.headers);
  backendHeaders.delete("host");
  backendHeaders.set("Connection", "Upgrade");
  backendHeaders.set("Upgrade", "websocket");
  [
    "cf-ray",
    "cf-visitor",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-worker",
    "x-proxy-auth",
  ].forEach((h) => backendHeaders.delete(h));
  if (clientIP) {
    backendHeaders.set("X-Forwarded-For", clientIP);
    backendHeaders.set("X-Real-IP", clientIP);
  }

  for (let i = 0; i < targets.length; i++) {
    const currentHost = targets[i];
    backendHeaders.set("Host", currentHost);
    const targetUrl = `${config.scheme}://${currentHost}:${config.targetPort}${url.pathname}${url.search}`;

    // Short timeout on the upgrade dial only — this does NOT limit how
    // long the connection stays open afterward, only how long we wait
    // for the initial 101 handshake to complete.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const backendResponse = await fetch(targetUrl, {
        method: "GET",
        headers: backendHeaders,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (backendResponse.status !== 101 || !backendResponse.webSocket) {
        try {
          await backendResponse.body?.cancel();
        } catch {
          // ignore
        }
        console.warn(
          `[WS] ${currentHost} rejected upgrade (status ${backendResponse.status})`,
        );
        if (i < targets.length - 1) continue;
        safeClose(workerSocket, 1011, "Backend upgrade rejected");
        safeClose(clientSocket, 1011, "Backend upgrade rejected");
        return new Response("Backend failed to upgrade ws connection.", {
          status: 502,
        });
      }

      const backendSocket = backendResponse.webSocket;
      backendSocket.accept();
      bridgeSockets(workerSocket, backendSocket);

      return new Response(null, { status: 101, webSocket: clientSocket });
    } catch (err) {
      clearTimeout(timer);
      console.error(`[WS FETCH ERROR] ${currentHost}: ${err.message}`);
      if (i === targets.length - 1) {
        safeClose(workerSocket, 1011, "Unable to connect to backend");
        safeClose(clientSocket, 1011, "Unable to connect to backend");
        return new Response("Unable to connect to backend service.", {
          status: 502,
        });
      }
      // otherwise fall through to try the next target
    }
  }

  return new Response("Unable to connect to backend service.", { status: 502 });
}

function safeClose(socket, code, reason) {
  const safeReason = (reason || "").slice(0, 123);
  try {
    socket.close(code, safeReason);
  } catch {
    try {
      socket.close();
    } catch {
      // socket may already be closed
    }
  }
}

function bridgeSockets(clientSocket, backendSocket) {
  let closed = false;

  const closeBoth = (code, reason) => {
    if (closed) return;
    closed = true;
    safeClose(clientSocket, code, reason);
    safeClose(backendSocket, code, reason);
  };

  clientSocket.addEventListener("message", (event) => {
    if (closed || backendSocket.readyState !== 1) return;
    try {
      backendSocket.send(event.data);
    } catch (err) {
      closeBoth(1011, "relay failure");
    }
  });

  backendSocket.addEventListener("message", (event) => {
    if (closed || clientSocket.readyState !== 1) return;
    try {
      clientSocket.send(event.data);
    } catch (err) {
      closeBoth(1011, "relay failure");
    }
  });

  clientSocket.addEventListener("close", (event) => {
    closeBoth(event.code, event.reason || "client closed connection");
  });
  backendSocket.addEventListener("close", (event) => {
    closeBoth(event.code, event.reason || "backend closed connection");
  });
  clientSocket.addEventListener("error", () => {
    closeBoth(1011, "client socket error");
  });
  backendSocket.addEventListener("error", () => {
    closeBoth(1011, "backend socket error");
  });
}

// fetch() transparently decompresses gzip/br bodies but leaves the original
// content-encoding/content-length headers intact — those get stripped or
// the client misreads the (already-decoded) body. Beyond that: Server, Via,
// X-Powered-By, and an absolute/backend-naming Location header can all leak
// that there's a second hop behind the Worker, or leak the origin's real
// hostname directly.
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
