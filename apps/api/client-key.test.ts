import { describe, expect, it } from 'vitest';
import { clientKey } from './client-key.ts';

describe('clientKey', () => {
  it('falls back to "anonymous" when X-Forwarded-For is absent', () => {
    expect(clientKey(undefined)).toBe('anonymous');
  });

  it('returns the only hop when the header is a single value', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
  });

  it("uses Railway's leftmost client entry when internal hop count varies", () => {
    expect(clientKey('203.0.113.8, 198.51.100.7, 192.0.2.9')).toBe('203.0.113.8');
  });

  it('rejects a non-IP first entry instead of creating attacker-controlled buckets', () => {
    expect(clientKey('arbitrary-text, 203.0.113.8')).toBe('anonymous');
  });

  it('handles array-shaped headers (Node IncomingMessage)', () => {
    expect(clientKey(['203.0.113.8', '192.0.2.9'])).toBe('203.0.113.8');
  });

  it('falls back to anonymous on empty / whitespace-only header', () => {
    expect(clientKey('')).toBe('anonymous');
    expect(clientKey('   ')).toBe('anonymous');
    expect(clientKey(',,,')).toBe('anonymous');
  });

  it('strips whitespace around hops', () => {
    expect(clientKey('1.1.1.1 ,  2.2.2.2  ')).toBe('1.1.1.1');
  });
});
