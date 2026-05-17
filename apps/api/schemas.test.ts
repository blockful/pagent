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

  it('applies default RATE_LIMIT_MAX=30 and RATE_LIMIT_WINDOW_MS=60000 when absent', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.RATE_LIMIT_MAX).toBe(30);
      expect(r.data.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    }
  });

  it('rejects RATE_LIMIT_MAX="-1" (non-positive)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'postgresql://x', RATE_LIMIT_MAX: '-1' });
    expect(r.success).toBe(false);
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
    });
    expect(r.success).toBe(true);
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

  it('treats empty-string PORT as unset and falls back to default', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', PORT: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.PORT).toBe(8787);
  });
});

// ---------------------------------------------------------------------------
// envSchema — auth-related vars
// ---------------------------------------------------------------------------

describe('envSchema (auth)', () => {
  it('defaults REQUIRE_AUTH to false when unset', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(false);
  });

  it('treats empty-string REQUIRE_AUTH as unset (default false)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(false);
  });

  it('parses successfully with REQUIRE_AUTH=false and no auth vars', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(false);
  });

  it('treats REQUIRE_AUTH="false" (string) as false (process.env is always strings)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: 'false' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(false);
  });

  it('treats REQUIRE_AUTH="true" (string) as true and gates auth vars', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: 'true' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('JWT_SIGNING_KEY'))).toBe(true);
    }
  });

  it('treats REQUIRE_AUTH="1" (string) as true', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      REQUIRE_AUTH: '1',
      JWT_SIGNING_KEY: 'k',
      JWT_PUBLIC_KEY: 'k',
      GOOGLE_CLIENT_ID: 'k',
      GOOGLE_CLIENT_SECRET: 'k',
      MAGIC_LINK_SECRET: 'k',
      AUTH_STATE_SECRET: 'k',
      SMTP_HOST: 'k',
      SMTP_USER: 'k',
      SMTP_PASS: 'k',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(true);
  });

  it('treats REQUIRE_AUTH="0" (string) as false', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: '0' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(false);
  });

  it('applies session/token/SMTP defaults when unset', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.SESSION_MAX_AGE_DAYS).toBe(30);
      expect(r.data.REFRESH_TOKEN_MAX_DAYS).toBe(90);
      expect(r.data.ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
      expect(r.data.SMTP_PORT).toBe(587);
      expect(r.data.SMTP_FROM).toBe('noreply@pagent.link');
    }
  });

  it('coerces SESSION_MAX_AGE_DAYS string to number', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', SESSION_MAX_AGE_DAYS: '60' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.SESSION_MAX_AGE_DAYS).toBe(60);
  });

  it('rejects SESSION_MAX_AGE_DAYS=0 (must be positive)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', SESSION_MAX_AGE_DAYS: '0' });
    expect(r.success).toBe(false);
  });

  it('rejects REFRESH_TOKEN_MAX_DAYS="-7" (non-positive)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REFRESH_TOKEN_MAX_DAYS: '-7' });
    expect(r.success).toBe(false);
  });

  it('rejects ACCESS_TOKEN_TTL_SECONDS="3.5" (non-int)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', ACCESS_TOKEN_TTL_SECONDS: '3.5' });
    expect(r.success).toBe(false);
  });

  it('rejects GOOGLE_REDIRECT_URI="not-a-url" (must be URL)', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      GOOGLE_REDIRECT_URI: 'not-a-url',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('GOOGLE_REDIRECT_URI'))).toBe(true);
    }
  });

  it('accepts GOOGLE_REDIRECT_URI as a valid URL', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      GOOGLE_REDIRECT_URI: 'https://pagent.link/oauth/callback/google',
    });
    expect(r.success).toBe(true);
  });

  it('rejects SMTP_FROM="not-an-email" (must be email)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', SMTP_FROM: 'not-an-email' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('SMTP_FROM'))).toBe(true);
    }
  });

  it('treats empty-string GOOGLE_REDIRECT_URI as unset', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', GOOGLE_REDIRECT_URI: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.GOOGLE_REDIRECT_URI).toBeUndefined();
  });

  it('treats empty-string SMTP_FROM as unset and applies default', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', SMTP_FROM: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.SMTP_FROM).toBe('noreply@pagent.link');
  });

  // --- superRefine: REQUIRE_AUTH=true gating ---------------------------------

  it('fails with REQUIRE_AUTH=true and missing JWT_SIGNING_KEY', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('JWT_SIGNING_KEY'))).toBe(true);
    }
  });

  it('reports every missing auth var (not just the first)', () => {
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      const missingPaths = r.error.issues.map((i) => i.path[0]);
      // All nine crypto/SMTP vars listed in the spec must appear as issues.
      for (const key of [
        'JWT_SIGNING_KEY',
        'JWT_PUBLIC_KEY',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'MAGIC_LINK_SECRET',
        'AUTH_STATE_SECRET',
        'SMTP_HOST',
        'SMTP_USER',
        'SMTP_PASS',
      ]) {
        expect(missingPaths).toContain(key);
      }
    }
  });

  it('accepts REQUIRE_AUTH=true when every required auth var is present', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      REQUIRE_AUTH: true,
      JWT_SIGNING_KEY: 'k1',
      JWT_PUBLIC_KEY: 'k2',
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
      MAGIC_LINK_SECRET: 'mls',
      AUTH_STATE_SECRET: 'ass',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(true);
  });

  it('treats empty-string auth vars as unset (so superRefine reports them as missing)', () => {
    // Regression for Railway: setting REQUIRE_AUTH=true with the auth vars as
    // empty placeholders must fail-fast at boot, not pass silently.
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      REQUIRE_AUTH: true,
      JWT_SIGNING_KEY: '',
      JWT_PUBLIC_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      MAGIC_LINK_SECRET: '',
      AUTH_STATE_SECRET: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('JWT_SIGNING_KEY'))).toBe(true);
    }
  });

  it('does NOT enforce auth vars when REQUIRE_AUTH=false (grace period)', () => {
    // Pre-rollout, the API boots with auth code present but enforcement off.
    // Crypto/SMTP can be absent; auth endpoints will 503 until configured.
    const r = envSchema.safeParse({ DATABASE_URL: 'x', REQUIRE_AUTH: false });
    expect(r.success).toBe(true);
  });
});
