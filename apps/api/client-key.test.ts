import { describe, expect, it } from 'vitest';
import { env } from './schemas.ts';
import { clientKey } from './client-key.ts';

describe('clientKey', () => {
  it('falls back to "anonymous" when X-Real-IP is absent', () => {
    expect(clientKey(undefined)).toBe('anonymous');
  });

  it('returns the only hop when the header is a single value', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
  });

  it('rejects a non-IP value instead of creating attacker-controlled buckets', () => {
    expect(clientKey('arbitrary-text')).toBe('anonymous');
  });

  it('handles array-shaped headers (Node IncomingMessage)', () => {
    expect(clientKey(['203.0.113.8'])).toBe('203.0.113.8');
    expect(clientKey(['203.0.113.8', '192.0.2.9'])).toBe('anonymous');
  });

  it('falls back to anonymous on empty / whitespace-only header', () => {
    expect(clientKey('')).toBe('anonymous');
    expect(clientKey('   ')).toBe('anonymous');
    expect(clientKey(',,,')).toBe('anonymous');
  });

  it('strips surrounding whitespace', () => {
    expect(clientKey('  1.1.1.1  ')).toBe('1.1.1.1');
  });

  it('does not trust the header outside the explicit Railway mode', () => {
    const original = env.TRUSTED_PROXY_MODE;
    env.TRUSTED_PROXY_MODE = undefined;
    try {
      expect(clientKey('203.0.113.8')).toBe('anonymous');
    } finally {
      env.TRUSTED_PROXY_MODE = original;
    }
  });
});
