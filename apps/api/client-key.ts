/**
 * Extract a stable rate-limit key from incoming request headers.
 *
 * Trust the LAST hop of `X-Forwarded-For`. Reverse proxies (Railway, Vercel,
 * Cloudflare) append the real client IP to the right of any incoming chain;
 * leftmost entries are whatever the client sent and so are attacker-
 * controllable. Using the last hop assumes exactly one trusted proxy in
 * front of the API. If you ever stack proxies, raise the index by hand.
 *
 * Falls back to "anonymous" if no X-Forwarded-For is present (or all hops
 * are blank), collapsing local-dev / test traffic into a single bucket.
 *
 * Accepts either a string or string[] so it works with both Hono's header
 * accessor (`c.req.header(...)`) and Node's IncomingMessage.headers shape.
 */
const ANONYMOUS = 'anonymous';

export function clientKey(xForwardedFor: string | string[] | undefined): string {
  if (!xForwardedFor) return ANONYMOUS;
  const raw = Array.isArray(xForwardedFor) ? xForwardedFor.join(',') : xForwardedFor;
  const hops = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0) return ANONYMOUS;
  return hops[hops.length - 1]!;
}
