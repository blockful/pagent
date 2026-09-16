/**
 * Schema unit tests — pure, no I/O, no DB.
 * DATABASE_URL is injected via vitest.config.ts test.env so schemas.ts parses cleanly.
 */
import { describe, expect, it } from 'vitest';
import { pageIdSchema } from './schemas.ts';

describe('pageIdSchema', () => {
  it('accepts a 32-char lowercase hex string', () => {
    expect(pageIdSchema.safeParse('a'.repeat(32)).success).toBe(true);
  });

  it('accepts a real-looking 32-char hex id', () => {
    expect(pageIdSchema.safeParse('d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9').success).toBe(true);
  });

  it('rejects a 31-char string', () => {
    expect(pageIdSchema.safeParse('a'.repeat(31)).success).toBe(false);
  });

  it('rejects a 33-char string', () => {
    expect(pageIdSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(pageIdSchema.safeParse('A'.repeat(32)).success).toBe(false);
  });

  it('rejects a string with g-z chars', () => {
    expect(pageIdSchema.safeParse('z'.repeat(32)).success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(pageIdSchema.safeParse('').success).toBe(false);
  });
});
