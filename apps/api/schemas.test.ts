/**
 * Schema unit tests — pure, no I/O, no DB.
 * DATABASE_URL is injected via vitest.config.ts test.env so schemas.ts parses cleanly.
 */
import { describe, expect, it } from 'vitest';
import { pageIdSchema, newPageBodySchema, resultBodySchema, envSchema } from './schemas.ts';

// ---------------------------------------------------------------------------
// pageIdSchema
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// newPageBodySchema
// ---------------------------------------------------------------------------

describe('newPageBodySchema', () => {
  it('rejects {} (no spec key)', () => {
    expect(newPageBodySchema.safeParse({}).success).toBe(false);
  });

  it('accepts { spec: null }', () => {
    expect(newPageBodySchema.safeParse({ spec: null }).success).toBe(true);
  });

  it('accepts { spec: [] }', () => {
    expect(newPageBodySchema.safeParse({ spec: [] }).success).toBe(true);
  });

  it('accepts { spec: { foo: 1 } }', () => {
    expect(newPageBodySchema.safeParse({ spec: { foo: 1 } }).success).toBe(true);
  });

  it('accepts { spec: "string" }', () => {
    expect(newPageBodySchema.safeParse({ spec: 'string' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resultBodySchema
// ---------------------------------------------------------------------------

describe('resultBodySchema', () => {
  it('accepts canonical action with all fields', () => {
    const r = resultBodySchema.safeParse({
      name: 'submitted',
      surfaceId: 'main',
      sourceComponentId: 'btn',
      context: { x: 1 },
      timestamp: '2026-01-01T00:00:00Z',
    });
    expect(r.success).toBe(true);
  });

  it('accepts minimum required fields and defaults context to {}', () => {
    const r = resultBodySchema.safeParse({ name: 'x', surfaceId: 'y' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.context).toEqual({});
  });

  it('rejects name: "" (empty name)', () => {
    expect(resultBodySchema.safeParse({ name: '', surfaceId: 'y' }).success).toBe(false);
  });

  it('passes through unknown extra fields (futureField)', () => {
    const r = resultBodySchema.safeParse({ name: 'a', surfaceId: 'b', futureField: 42 });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).futureField).toBe(42);
  });

  it('rejects malformed timestamp', () => {
    expect(
      resultBodySchema.safeParse({ name: 'x', surfaceId: 'y', timestamp: 'not a date' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// envSchema (tested directly, independent of the module-level env parse)
// ---------------------------------------------------------------------------

describe('envSchema', () => {
  it('rejects {} (missing DATABASE_URL)', () => {
    expect(envSchema.safeParse({}).success).toBe(false);
  });

  it('parses default PORT=8787 when PORT is absent', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PORT).toBe(8787);
  });

  it('coerces PORT string to number', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x', PORT: '9999' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PORT).toBe(9999);
  });

  it('trims and filters ALLOWED_ORIGINS', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'postgresql://x',
      ALLOWED_ORIGINS: 'https://a.com,  https://b.com ,',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ALLOWED_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns undefined for absent ALLOWED_ORIGINS', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ALLOWED_ORIGINS).toBeUndefined();
  });

  it('rejects LOG_LEVEL="banana" (not a valid level)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x', LOG_LEVEL: 'banana' });
    expect(r.success).toBe(false);
  });
});
