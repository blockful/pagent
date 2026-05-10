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
 *
 * Memory is bounded by an opportunistic sweep on every Nth call — see
 * `SWEEP_INTERVAL` below.
 */
type Bucket = { count: number; resetAt: number };

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the bucket resets. Used both as `Retry-After` (when
   *  blocked) and as the `reset` field of the IETF draft-7 RateLimit header. */
  secondsUntilReset: number;
  remaining: number;
  limit: number;
};

export class RateLimiter {
  /** Sweep expired entries every N `check` calls. Keeps the Map bounded
   *  under high-cardinality IP traffic without needing a setInterval. */
  private static readonly SWEEP_INTERVAL = 100;

  private readonly buckets = new Map<string, Bucket>();
  private callsSinceSweep = 0;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Increment the bucket for `key` and return whether the request is allowed. */
  check(key: string, now: number = Date.now()): RateLimitResult {
    if (++this.callsSinceSweep >= RateLimiter.SWEEP_INTERVAL) {
      this.callsSinceSweep = 0;
      this.purgeExpired(now);
    }

    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const allowed = b.count <= this.limit;
    return {
      allowed,
      secondsUntilReset: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      remaining: Math.max(0, this.limit - b.count),
      limit: this.limit,
    };
  }

  /** Window length in whole seconds — useful for the RateLimit-Policy header. */
  windowSeconds(): number {
    return Math.max(1, Math.floor(this.windowMs / 1000));
  }

  /** Drop all state. Test-only — not called from production code. */
  reset(): void {
    this.buckets.clear();
    this.callsSinceSweep = 0;
  }

  private purgeExpired(now: number): void {
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }
}
