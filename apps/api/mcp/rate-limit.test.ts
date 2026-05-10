import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.ts';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  const NOW = 1_000_000;

  beforeEach(() => {
    limiter = new RateLimiter(3, 60_000);
  });

  it('allows requests up to the configured limit', () => {
    expect(limiter.check('a', NOW).allowed).toBe(true);
    expect(limiter.check('a', NOW).allowed).toBe(true);
    expect(limiter.check('a', NOW).allowed).toBe(true);
  });

  it('rejects the (limit+1)-th request and reports a positive retry', () => {
    for (let i = 0; i < 3; i++) limiter.check('a', NOW);
    const result = limiter.check('a', NOW);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keys per identifier — exhausting one bucket does not affect another', () => {
    for (let i = 0; i < 3; i++) limiter.check('a', NOW);
    expect(limiter.check('a', NOW).allowed).toBe(false);
    expect(limiter.check('b', NOW).allowed).toBe(true);
  });

  it('resets when the window has elapsed', () => {
    for (let i = 0; i < 3; i++) limiter.check('a', NOW);
    expect(limiter.check('a', NOW).allowed).toBe(false);
    // Jump past the window boundary.
    expect(limiter.check('a', NOW + 60_001).allowed).toBe(true);
  });

  it('reports remaining count alongside the verdict', () => {
    expect(limiter.check('a', NOW).remaining).toBe(2);
    expect(limiter.check('a', NOW).remaining).toBe(1);
    expect(limiter.check('a', NOW).remaining).toBe(0);
    expect(limiter.check('a', NOW).remaining).toBe(0);
  });

  it('exposes the configured limit', () => {
    expect(limiter.check('a', NOW).limit).toBe(3);
  });

  it('reset() drops all state', () => {
    for (let i = 0; i < 3; i++) limiter.check('a', NOW);
    expect(limiter.check('a', NOW).allowed).toBe(false);
    limiter.reset();
    expect(limiter.check('a', NOW).allowed).toBe(true);
  });
});
