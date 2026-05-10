/**
 * Per-IP token bucket for the HTTP MCP endpoint.
 *
 * Mirrors the per-IP cap that hono-rate-limiter enforces on POST /new, but
 * keeps its own in-memory store. REST and MCP have separate buckets — an
 * attacker has to spread effort across both endpoints to double the
 * effective rate, but the implementation cost of unified buckets is too
 * high for the marginal protection it would buy. Acceptable for pagent's
 * traffic profile; revisit if abuse appears.
 *
 * State is in-process only. A restart resets buckets, and horizontally
 * scaled instances do not share state. Both are fine here: the API has
 * one Railway instance today, and the limit is a soft signal, not an
 * authentication boundary.
 */
type Bucket = { count: number; resetAt: number };

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Increment the bucket for `key` and return whether the request is allowed. */
  check(key: string, now: number = Date.now()): RateLimitResult {
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const allowed = b.count <= this.limit;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.ceil((b.resetAt - now) / 1000),
      remaining: Math.max(0, this.limit - b.count),
      limit: this.limit,
    };
  }

  /** Drop all state. Test-only. */
  reset(): void {
    this.buckets.clear();
  }
}
