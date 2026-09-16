/**
 * Schema unit tests — pure, no I/O, no DB.
 * DATABASE_URL is injected via vitest.config.ts test.env so schemas.ts parses cleanly.
 */
import { describe, expect, it } from 'vitest';
import { newPageBodySchema } from './schemas.ts';

describe('newPageBodySchema', () => {
  it('rejects {} (no spec key)', () => {
    expect(newPageBodySchema.safeParse({}).success).toBe(false);
  });

  it('defaults format to "a2ui" when absent', () => {
    const r = newPageBodySchema.safeParse({ spec: { foo: 1 } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe('a2ui');
  });

  it('accepts explicit { format: "a2ui", spec: [] }', () => {
    const r = newPageBodySchema.safeParse({ format: 'a2ui', spec: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe('a2ui');
  });

  it('accepts { format: "html", spec: "<div>hi</div>" }', () => {
    const r = newPageBodySchema.safeParse({ format: 'html', spec: '<div>hi</div>' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.format).toBe('html');
      expect(r.data.spec).toBe('<div>hi</div>');
    }
  });

  it('rejects { format: "html", spec: [] } (HTML spec must be string)', () => {
    expect(newPageBodySchema.safeParse({ format: 'html', spec: [] }).success).toBe(false);
  });

  it('rejects { format: "html", spec: "" } (HTML spec must be non-empty)', () => {
    expect(newPageBodySchema.safeParse({ format: 'html', spec: '' }).success).toBe(false);
  });

  it('rejects { format: "html", spec: <1 MB + 1 byte string> }', () => {
    const big = 'a'.repeat(1_000_001);
    expect(newPageBodySchema.safeParse({ format: 'html', spec: big }).success).toBe(false);
  });

  it('rejects { format: "rss", spec: "x" } (unknown format)', () => {
    expect(newPageBodySchema.safeParse({ format: 'rss', spec: 'x' }).success).toBe(false);
  });

  it('still accepts pre-existing payloads with no format field', () => {
    // Backwards compatibility — all existing MCP clients post `{ spec }` only.
    expect(newPageBodySchema.safeParse({ spec: null }).success).toBe(true);
    expect(newPageBodySchema.safeParse({ spec: [] }).success).toBe(true);
    expect(newPageBodySchema.safeParse({ spec: { foo: 1 } }).success).toBe(true);
    expect(newPageBodySchema.safeParse({ spec: 'string' }).success).toBe(true);
  });
});
