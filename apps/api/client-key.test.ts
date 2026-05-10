import { describe, expect, it } from 'vitest';
import { clientKey } from './client-key.ts';

describe('clientKey', () => {
  it('falls back to "anonymous" when X-Forwarded-For is absent', () => {
    expect(clientKey(undefined)).toBe('anonymous');
  });

  it('returns the only hop when the header is a single value', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
  });

  it('trusts the LAST hop in a multi-hop chain (anti-spoofing)', () => {
    expect(clientKey('evil-spoof, evil-spoof-2, real-client')).toBe('real-client');
  });

  it('handles array-shaped headers (Node IncomingMessage)', () => {
    expect(clientKey(['evil-spoof', 'real-client'])).toBe('real-client');
  });

  it('falls back to anonymous on empty / whitespace-only header', () => {
    expect(clientKey('')).toBe('anonymous');
    expect(clientKey('   ')).toBe('anonymous');
    expect(clientKey(',,,')).toBe('anonymous');
  });

  it('strips whitespace around hops', () => {
    expect(clientKey('1.1.1.1 ,  2.2.2.2  ')).toBe('2.2.2.2');
  });
});
