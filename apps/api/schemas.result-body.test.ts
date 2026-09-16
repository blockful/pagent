/**
 * Schema unit tests — pure, no I/O, no DB.
 * DATABASE_URL is injected via vitest.config.ts test.env so schemas.ts parses cleanly.
 */
import { describe, expect, it } from 'vitest';
import { resultBodySchema } from './schemas.ts';

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
