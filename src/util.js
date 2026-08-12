// Small, dependency-free helpers shared across the worker. Nothing here
// requires a Workers compatibility flag (e.g. nodejs_compat) to run.

/**
 * Approximately constant-time string comparison. A plain `===`/`!==` on the
 * access token leaks two timing signals: it returns as soon as it hits the
 * first mismatched character, and it returns instantly on a length
 * mismatch. This removes both — it always walks the full max length of the
 * two inputs and OR-accumulates the differences, so the time taken doesn't
 * depend on *where* the strings first diverge.
 *
 * This is not a cryptographic guarantee (V8's JIT can still introduce some
 * variance), and a real network's jitter already makes timing attacks on a
 * token like this impractical. It's included because it's effectively free
 * and it's the standard-practice way to compare secrets.
 */
export function safeEqual(a, b) {
  const ta = new TextEncoder().encode(String(a));
  const tb = new TextEncoder().encode(String(b));

  let result = ta.length === tb.length ? 0 : 1;
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = i < ta.length ? ta[i] : 0;
    const y = i < tb.length ? tb[i] : 0;
    result |= x ^ y;
  }
  return result === 0;
}

/**
 * True if `pathname` IS the gate path, or a subpath of it
 * (`/apitax` or `/apitax/whatever`) — but NOT a path that merely starts
 * with the same characters (`/apitax2`, `/apitaxLOL`). A plain
 * `pathname.startsWith(gatePath)` lets those false positives through,
 * which slightly widens what counts as "the secret."
 */
export function pathMatchesGate(pathname, gatePath) {
  if (!gatePath) return false;
  if (pathname === gatePath) return true;
  const withSlash = gatePath.endsWith("/") ? gatePath : gatePath + "/";
  return pathname.startsWith(withSlash);
}
