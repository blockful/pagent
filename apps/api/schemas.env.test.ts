/**
 * Schema unit tests — pure, no I/O, no DB.
 * DATABASE_URL is injected via vitest.config.ts test.env so schemas.ts parses cleanly.
 */
import { describe, expect, it } from 'vitest';
import { envSchema } from './schemas.ts';

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
    expect(
      envSchema.safeParse({ DATABASE_URL: 'postgresql://x', LOG_LEVEL: 'banana' }).success,
    ).toBe(false);
  });

  it('applies default RATE_LIMIT_MAX=30 and RATE_LIMIT_WINDOW_MS=60000 when absent', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.RATE_LIMIT_MAX).toBe(30);
      expect(r.data.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    }
  });

  it('rejects RATE_LIMIT_MAX="-1" (non-positive)', () => {
    expect(
      envSchema.safeParse({ DATABASE_URL: 'postgresql://x', RATE_LIMIT_MAX: '-1' }).success,
    ).toBe(false);
  });

  it('requires ALLOWED_ORIGINS when NODE_ENV=production', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', NODE_ENV: 'production' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('ALLOWED_ORIGINS'))).toBe(true);
    }
  });

  it('requires non-empty ALLOWED_ORIGINS in production', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: '',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('ALLOWED_ORIGINS'))).toBe(true);
    }
  });

  it('accepts production with valid ALLOWED_ORIGINS', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
      TRUSTED_PROXY_MODE: 'railway',
    });
    expect(r.success).toBe(true);
  });

  it('rejects production DATABASE_URL with sslmode=disable', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@db.example.com/app?sslmode=disable',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
      TRUSTED_PROXY_MODE: 'railway',
    });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('DATABASE_URL'))).toBe(true);
    }
  });

  it.each(['development', 'test'] as const)('allows sslmode=disable in %s', (nodeEnv) => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost/app?sslmode=disable',
      NODE_ENV: nodeEnv,
    });

    expect(r.success).toBe(true);
  });

  it('requires an explicit trusted proxy mode in production', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('TRUSTED_PROXY_MODE'))).toBe(true);
    }
  });

  it('accepts the Railway trusted-ingress contract in production', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
      TRUSTED_PROXY_MODE: 'railway',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.TRUSTED_PROXY_MODE).toBe('railway');
  });

  it('rejects unsupported trusted proxy modes', () => {
    expect(
      envSchema.safeParse({ DATABASE_URL: 'x', TRUSTED_PROXY_MODE: 'untrusted' }).success,
    ).toBe(false);
  });

  it('accepts development without ALLOWED_ORIGINS', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', NODE_ENV: 'development' });
    expect(r.success).toBe(true);
  });

  it('accepts test without ALLOWED_ORIGINS', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', NODE_ENV: 'test' });
    expect(r.success).toBe(true);
  });

  it('requires PUBLIC_URL when NODE_ENV=production', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://a.com',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('PUBLIC_URL'))).toBe(true);
    }
  });

  it('accepts production with valid PUBLIC_URL', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://a.com',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
      TRUSTED_PROXY_MODE: 'railway',
    });
    expect(r.success).toBe(true);
  });

  it('requires API_PUBLIC_URL when NODE_ENV=production', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('API_PUBLIC_URL'))).toBe(true);
    }
  });

  it.each([
    ['PUBLIC_URL', 'http://pagent.link'],
    ['PUBLIC_URL', 'ftp://pagent.link'],
    ['PUBLIC_URL', 'javascript:alert(1)'],
    ['PUBLIC_URL', 'https://pagent.link/pages'],
    ['PUBLIC_URL', 'https://user:pass@pagent.link'],
    ['PUBLIC_URL', 'https://pagent.link?preview=1'],
    ['PUBLIC_URL', 'https://pagent.link#preview'],
    ['API_PUBLIC_URL', 'http://api.pagent.link'],
    ['API_PUBLIC_URL', 'ftp://api.pagent.link'],
    ['API_PUBLIC_URL', 'javascript:alert(1)'],
    ['API_PUBLIC_URL', 'https://api.pagent.link/v1'],
  ])('rejects production %s=%s because public URLs must be HTTPS origins', (key, value) => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
      TRUSTED_PROXY_MODE: 'railway',
      [key]: value,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes(key))).toBe(true);
  });

  it('accepts distinct HTTPS renderer and API origins in production', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://pagent.link',
      PUBLIC_URL: 'https://pagent.link',
      API_PUBLIC_URL: 'https://api.pagent.link',
      TRUSTED_PROXY_MODE: 'railway',
    });
    expect(r.success).toBe(true);
  });

  it('development without PUBLIC_URL still parses', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', NODE_ENV: 'development' });
    expect(r.success).toBe(true);
  });

  // Regression: Railway/Nixpacks pass unset env vars to Node as "" rather than
  // omitting them. A previous schema rejected NODE_ENV="" as an invalid enum,
  // crash-looping the API on every Railway boot.
  it('treats empty-string NODE_ENV as unset', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', NODE_ENV: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.NODE_ENV).toBeUndefined();
  });

  it('treats empty-string LOG_LEVEL as unset', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', LOG_LEVEL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.LOG_LEVEL).toBeUndefined();
  });

  it('treats empty-string PUBLIC_URL as unset (would otherwise fail .url())', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', PUBLIC_URL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PUBLIC_URL).toBeUndefined();
  });

  it('treats empty-string API_PUBLIC_URL as unset', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', API_PUBLIC_URL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.API_PUBLIC_URL).toBeUndefined();
  });

  it('treats empty-string PORT as unset and falls back to default', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', PORT: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PORT).toBe(8787);
  });
});
