/**
 * Unit tests for the formatRetryHint helper exported from lib.ts.
 * Only the pure helper is tested here; full show_ui / check_result flows
 * are covered by the smoke script (apps/mcp/smoke.mjs).
 */
import { describe, expect, it } from 'vitest';
import { formatRetryHint } from './lib.ts';

describe('formatRetryHint', () => {
  it('returns empty string for an empty body', () => {
    expect(formatRetryHint({})).toBe('');
  });

  it('returns retry hint when retry_after_seconds is present', () => {
    expect(formatRetryHint({ retry_after_seconds: 60 })).toBe('Retry after 60s');
  });

  it('returns size hint when max_bytes is present', () => {
    expect(formatRetryHint({ max_bytes: 262144 })).toBe('Reduce body to ≤262144 bytes');
  });

  it('prefers retry_after_seconds over max_bytes when both are present', () => {
    expect(formatRetryHint({ retry_after_seconds: 30, max_bytes: 262144 })).toBe('Retry after 30s');
  });
});
