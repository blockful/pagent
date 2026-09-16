/**
 * Schema unit tests — pure, no I/O, no DB.
 * DATABASE_URL is injected via vitest.config.ts test.env so schemas.ts parses cleanly.
 */
import { describe, expect, it } from 'vitest';
import { envSchema } from './schemas.ts';

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
      AUTH_STATE_SECRET: 'k'.repeat(32),
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
    expect(envSchema.safeParse({ DATABASE_URL: 'x', SESSION_MAX_AGE_DAYS: '0' }).success).toBe(
      false,
    );
  });

  it('rejects REFRESH_TOKEN_MAX_DAYS="-7" (non-positive)', () => {
    expect(envSchema.safeParse({ DATABASE_URL: 'x', REFRESH_TOKEN_MAX_DAYS: '-7' }).success).toBe(
      false,
    );
  });

  it('rejects ACCESS_TOKEN_TTL_SECONDS="3.5" (non-int)', () => {
    expect(
      envSchema.safeParse({ DATABASE_URL: 'x', ACCESS_TOKEN_TTL_SECONDS: '3.5' }).success,
    ).toBe(false);
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

  it.each(['http://api.pagent.link/oauth/callback/google', 'ftp://api.pagent.link/callback'])(
    'rejects production GOOGLE_REDIRECT_URI=%s because callbacks require HTTPS',
    (redirectUri) => {
      const r = envSchema.safeParse({
        DATABASE_URL: 'x',
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://pagent.link',
        PUBLIC_URL: 'https://pagent.link',
        API_PUBLIC_URL: 'https://api.pagent.link',
        GOOGLE_REDIRECT_URI: redirectUri,
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes('GOOGLE_REDIRECT_URI'))).toBe(true);
      }
    },
  );

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
      // All crypto/SMTP vars listed in the spec must appear as issues.
      for (const key of [
        'JWT_SIGNING_KEY',
        'JWT_PUBLIC_KEY',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
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
      AUTH_STATE_SECRET: 'a'.repeat(32),
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REQUIRE_AUTH).toBe(true);
  });

  it('rejects AUTH_STATE_SECRET shorter than 32 UTF-8 bytes when auth is required', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      REQUIRE_AUTH: true,
      JWT_SIGNING_KEY: 'k1',
      JWT_PUBLIC_KEY: 'k2',
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
      AUTH_STATE_SECRET: 'too-short',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('AUTH_STATE_SECRET'))).toBe(true);
    }
  });

  it('counts AUTH_STATE_SECRET length in UTF-8 bytes', () => {
    const r = envSchema.safeParse({
      DATABASE_URL: 'x',
      REQUIRE_AUTH: true,
      JWT_SIGNING_KEY: 'k1',
      JWT_PUBLIC_KEY: 'k2',
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
      AUTH_STATE_SECRET: 'é'.repeat(16),
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
    });
    expect(r.success).toBe(true);
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
