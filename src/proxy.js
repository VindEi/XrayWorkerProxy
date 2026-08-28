import { connect } from "cloudflare:sockets";

// WebSocket opcodes (RFC 6455)
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const WS_HANDSHAKE_TIMEOUT_MS = 8000;
const MAX_FRAME_SIZE = 16 * 1024 * 1024; // sanity cap on a single ws frame
const TEXT_ENCODER = new TextEncoder();

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

  // Non-WS headers: full clone + sanitize.
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
  // NOTE: we deliberately do NOT set a Host header here. Workers derive the
  // outbound Host from the fetch URL and silently ignore overrides.

  // Snapshot the request for failover BEFORE the first attempt. request.body
  // is a one-shot stream — by the time attempt #0 fails, it's consumed, and
  // clone() would throw. Clone up front instead.
  const retryRequest = targets.length > 1 ? request.clone() : null;

  for (let i = 0; i < targets.length; i++) {
    const currentHost = targets[i];
    const targetUrl = `${config.scheme}://${currentHost}:${config.targetPort}${url.pathname}${url.search}`;

    const fetchOptions = {
      method: request.method,
      headers: modifiedHeaders,
      redirect: "manual",
      cf: { cacheTtl: 0, cacheEverything: false },
    };

    if (config.timeoutMs > 0) {
      fetchOptions.signal = AbortSignal.timeout(config.timeoutMs);
    }

    if (
      !["GET", "HEAD"].includes(request.method.toUpperCase()) &&
      request.body
    ) {
      fetchOptions.body = (i === 0 ? request : retryRequest).body;
      fetchOptions.duplex = "half";
    }

    try {
      const response = await fetch(targetUrl, fetchOptions);

      // Auto-failover on 502/503/504
      if ([502, 503, 504].includes(response.status) && i < targets.length - 1) {
        try {
          await response.body?.cancel();
        } catch {}
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

// --- WebSocket handling (raw TCP relay via cloudflare:sockets) ----------
//
// Architecture: client <-> Worker is a normal WebSocket (terminated here).
// Worker <-> origin is a RAW TCP socket. Since the origin is a real ws
// server (Xray), the TCP leg must speak the WebSocket protocol itself:
//   1. synthesize the HTTP/1.1 upgrade request,
//   2. parse the origin's 101 response (byte-safe — leftover bytes after
//      the header are binary frame data, never round-trip them through a
//      TextDecoder),
//   3. from then on, encode client payloads as MASKED binary ws frames
//      (RFC 6455 requires client->server masking; gorilla/nhooyr enforce
//      it) and parse the origin's frames back into raw payloads.
//
// This gives true full-duplex streaming — ws through this worker behaves
// like stream-one, one request per connection instead of a POST storm.
//
// Confidentiality note: with SCHEME=http the TCP leg is plaintext. That is
// acceptable ONLY because the payload inside is encrypted at the VLESS
// layer (mlkem768x25519plus) — keep VLESS encryption ON at the origin.

async function handleWebSocketUpgrade(request, url, targets, config, clientIP) {
  if (request.method.toUpperCase() !== "GET") {
    return new Response("ws upgrade requests must use GET.", { status: 400 });
  }

  const port = parseInt(config.targetPort, 10);
  // SCHEME controls whether the origin TCP leg gets wrapped in TLS. With a
  // bare-IP TARGET_HOST this must stay "http" — there is no certificate for
  // an IP, and Workers fetch/connect cannot skip cert verification.
  const useTls = (config.scheme || "http").toLowerCase() === "https";

  for (const target of targets) {
    let socket = null;
    try {
      socket = connect(
        { hostname: target, port },
        { secureTransport: useTls ? "on" : "off" },
      );
      await withTimeout(
        socket.opened,
        WS_HANDSHAKE_TIMEOUT_MS,
        `connect ${target}`,
      );

      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();

      await withTimeout(
        writer.write(
          TEXT_ENCODER.encode(buildUpgradeRequest(url, target, clientIP)),
        ),
        WS_HANDSHAKE_TIMEOUT_MS,
        `handshake write ${target}`,
      );

      const buf = new ByteBuf();
      const head = await withTimeout(
        readHandshakeHead(reader, buf),
        WS_HANDSHAKE_TIMEOUT_MS,
        `handshake read ${target}`,
      );

      if (head.status !== 101) {
        console.warn(`[WS] ${target} rejected upgrade (status ${head.status})`);
        await cleanupSocket(socket, reader, writer);
        continue; // failover to next target
      }

      const [clientSock, workerSock] = Object.values(new WebSocketPair());
      workerSock.accept();
      startRelay(workerSock, clientSock, socket, reader, writer, head.leftover);

      return new Response(null, { status: 101, webSocket: clientSock });
    } catch (err) {
      console.error(`[WS FETCH ERROR] ${target}: ${err.message}`);
      try {
        socket?.close();
      } catch {}
      continue;
    }
  }

  return new Response("Unable to connect to backend service.", { status: 502 });
}

function buildUpgradeRequest(url, originHost, clientIP) {
  // Minimal RFC 6455 client handshake. We deliberately do NOT offer
  // permessage-deflate (no Sec-WebSocket-Extensions) so the origin never
  // compresses frames — keeps the relay byte-transparent and the parser
  // simple. If you enable ws early-data ("ed") in 3x-ui, the ?ed=NNNN
  // query arrives in url.search and is forwarded untouched.
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${originHost}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Key: ${makeWsKey()}`,
    `Sec-WebSocket-Version: 13`,
  ];
  if (clientIP) {
    lines.push(`X-Forwarded-For: ${clientIP}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

function makeWsKey() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function readHandshakeHead(reader, buf) {
  for (;;) {
    const end = findHeaderEnd(buf);
    if (end !== -1) {
      const headText = new TextDecoder().decode(
        buf.data.subarray(buf.pos, end),
      );
      const statusLine = headText.split("\r\n")[0] || "";
      const m = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
      const status = m ? parseInt(m[1], 10) : 0;
      const leftover = buf.data.subarray(end + 4);
      return { status, leftover };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("origin closed during handshake");
    buf.append(value);
  }
}

// Scan raw bytes for \r\n\r\n (headers are ASCII, but any bytes past the
// header are BINARY frame data — never decode them to find the boundary).
function findHeaderEnd(buf) {
  const d = buf.data;
  for (let i = buf.pos; i <= d.length - 4; i++) {
    if (
      d[i] === 0x0d &&
      d[i + 1] === 0x0a &&
      d[i + 2] === 0x0d &&
      d[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

function startRelay(workerSock, clientSock, socket, reader, writer, leftover) {
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    try {
      reader.cancel();
    } catch {}
    try {
      writer.close();
    } catch {}
    try {
      socket.close();
    } catch {}
    try {
      workerSock.close(1000, "");
    } catch {}
    try {
      clientSock.close(1000, "");
    } catch {}
  };

  // Uplink: client ws messages -> masked binary ws frames -> origin TCP.
  // Consecutive write() calls on a single writer are queued in order, so
  // fire-and-forget here preserves message ordering.
  workerSock.addEventListener("message", (ev) => {
    if (closed) return;
    const payload =
      typeof ev.data === "string"
        ? TEXT_ENCODER.encode(ev.data)
        : new Uint8Array(ev.data);
    writer.write(encodeFrame(OP_BINARY, payload)).catch(shutdown);
  });
  workerSock.addEventListener("close", shutdown);
  workerSock.addEventListener("error", shutdown);

  // Downlink: origin ws frames -> payloads -> client socket.
  pumpDownlink(reader, writer, leftover, workerSock, shutdown).catch(shutdown);
}

async function pumpDownlink(reader, writer, leftover, workerSock, shutdown) {
  const buf = new ByteBuf(leftover);
  let fragParts = [];

  for (;;) {
    if (!(await buf.fill(reader, 2))) return shutdown();
    const b0 = buf.take(2);
    const fin = (b0[0] & 0x80) !== 0;
    const opcode = b0[0] & 0x0f;
    const masked = (b0[1] & 0x80) !== 0; // servers must not mask; tolerate anyway
    let len = b0[1] & 0x7f;

    if (len === 126) {
      if (!(await buf.fill(reader, 2))) return shutdown();
      const e = buf.take(2);
      len = (e[0] << 8) | e[1];
    } else if (len === 127) {
      if (!(await buf.fill(reader, 8))) return shutdown();
      const e = buf.take(8);
      len = 0;
      for (let i = 0; i < 8; i++) len = len * 256 + e[i];
      if (len > MAX_FRAME_SIZE) return shutdown();
    }

    // Control frames cannot be fragmented and are <= 125 bytes.
    if (opcode >= 0x8 && (!fin || len > 125)) return shutdown();

    const maskKey = masked ? buf.take(4).slice() : null;
    if (!(await buf.fill(reader, len))) return shutdown();
    const payload = buf.take(len).slice();
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }

    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (fin) {
          try {
            workerSock.send(payload);
          } catch {
            return shutdown();
          }
        } else {
          fragParts.push(payload); // fragmented message, keep accumulating
        }
        break;
      case OP_CONT:
        fragParts.push(payload);
        if (fin) {
          const combined = concatBytes(fragParts);
          fragParts = [];
          try {
            workerSock.send(combined);
          } catch {
            return shutdown();
          }
        }
        break;
      case OP_PING:
        // Must answer pings on the origin leg or it will drop us.
        try {
          await writer.write(encodeFrame(OP_PONG, payload));
        } catch {
          return shutdown();
        }
        break;
      case OP_PONG:
        break;
      case OP_CLOSE:
        return shutdown();
      default:
        return shutdown(); // unknown opcode — refuse to desync silently
    }
  }
}

// Encode a client->server ws frame. Client frames MUST be masked
// (RFC 6455 §5.3); Xray's ws server enforces this.
function encodeFrame(opcode, payload, fin = true) {
  const len = payload.byteLength;
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const extLenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const frame = new Uint8Array(2 + extLenBytes + 4 + len);

  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = len & 0xff;
  } else {
    frame[1] = 0x80 | 127;
    for (let i = 0; i < 8; i++) {
      frame[2 + i] = Math.floor(len / 2 ** (8 * (7 - i))) & 0xff;
    }
  }
  frame.set(mask, 2 + extLenBytes);
  const start = 2 + extLenBytes + 4;
  for (let i = 0; i < len; i++) frame[start + i] = payload[i] ^ mask[i & 3];
  return frame;
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function cleanupSocket(socket, reader, writer) {
  try {
    await writer.close();
  } catch {}
  try {
    await reader.cancel();
  } catch {}
  try {
    socket.close();
  } catch {}
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Growable byte buffer with a read cursor. append() never mutates existing
// arrays in place, so subarray views taken earlier (mask keys, etc.) stay
// valid even after new chunks arrive.
class ByteBuf {
  constructor(init = new Uint8Array(0)) {
    this.data = init;
    this.pos = 0;
  }
  get remaining() {
    return this.data.length - this.pos;
  }
  async fill(reader, need) {
    while (this.remaining < need) {
      const { value, done } = await reader.read();
      if (done || !value) return false;
      this.append(value);
    }
    return true;
  }
  append(chunk) {
    const avail = this.data.length - this.pos;
    const merged = new Uint8Array(avail + chunk.length);
    merged.set(this.data.subarray(this.pos));
    merged.set(chunk, avail);
    this.data = merged;
    this.pos = 0;
  }
  take(n) {
    const view = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return view;
  }
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
