import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from './db';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on first attempt without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('success');

    const promise = withRetry(fn);
    // Advance through both backoff windows
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    const boom = new Error('boom');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(boom)
      .mockRejectedValueOnce(boom)
      .mockRejectedValueOnce(boom);

    const promise = withRetry(fn);
    // Attach rejection handler before advancing timers to avoid unhandled rejection warnings
    const caught = promise.catch((e) => e);
    await vi.runAllTimersAsync();

    const err = await caught;
    expect(err).toBe(boom);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce(new Error('nope'));

    const promise = withRetry(fn, { attempts: 5 });
    const caught = promise.catch((e) => e);
    await vi.runAllTimersAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('respects custom baseDelayMs', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce('done');

    const startTime = Date.now();
    const promise = withRetry(fn, { baseDelayMs: 1000 });
    await vi.runAllTimersAsync();
    await promise;

    // With baseDelayMs=1000 and 0.75–1.25 jitter factor, delay is 750–1250ms
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(750);
  });

  it('applies jitter so consecutive retry delays differ', async () => {
    const delays: number[] = [];

    for (let run = 0; run < 10; run++) {
      const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('y');

      const startTime = Date.now();
      const promise = withRetry(fn, { baseDelayMs: 100 });
      await vi.runAllTimersAsync();
      await promise;
      delays.push(Date.now() - startTime);
    }

    // All delays should be in the 75–125ms range (±25% of 100ms)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(75);
      expect(d).toBeLessThanOrEqual(125);
    }
    // At least two distinct values confirm jitter is applied
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(1);
  });
});
