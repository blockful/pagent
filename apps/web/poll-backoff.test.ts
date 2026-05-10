import { describe, it, expect } from 'vitest';
import { nextPollDelay, pollTimeoutMessage } from './poll-backoff.js';

describe('nextPollDelay', () => {
  it('doubles within bounds', () => {
    expect(nextPollDelay(2000, 2, 30_000)).toBe(4000);
  });

  it('doubles to the cap', () => {
    expect(nextPollDelay(20_000, 2, 30_000)).toBe(30_000);
  });

  it('caps when already at the cap', () => {
    expect(nextPollDelay(30_000, 2, 30_000)).toBe(30_000);
  });

  it('handles factor 1 (no-op)', () => {
    expect(nextPollDelay(5000, 1, 30_000)).toBe(5000);
  });
});

describe('pollTimeoutMessage', () => {
  it('returns a stable string', () => {
    expect(pollTimeoutMessage()).toBe(pollTimeoutMessage());
  });

  it('mentions saved', () => {
    expect(pollTimeoutMessage()).toContain('saved');
  });

  it('mentions agent', () => {
    expect(pollTimeoutMessage()).toContain('agent');
  });
});
