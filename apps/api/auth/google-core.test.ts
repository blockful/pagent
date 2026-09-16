import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../schemas.ts';
import { renderConsentPage } from './consent-page.ts';
import { buildGoogleAuthUrl, exchangeGoogleCode } from './google.ts';
import { renderLoginPage } from './login-page.ts';
import { signStateJwt, verifyStateJwt } from './state-jwt.ts';
import { mockGoogleTokenResponse, setupGoogleAuthTest } from './google-test-support.ts';

beforeAll(setupGoogleAuthTest);
beforeEach(() => vi.clearAllMocks());

describe('buildGoogleAuthUrl', () => {
  it('returns a Google auth URL with all required parameters', () => {
    const url = buildGoogleAuthUrl('signed-state-jwt');
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('test-google-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost/oauth/callback/google');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    expect(parsed.searchParams.get('state')).toBe('signed-state-jwt');
  });

  it('uses API_PUBLIC_URL for the default callback when no override is configured', () => {
    const originalRedirect = env.GOOGLE_REDIRECT_URI;
    const originalApiUrl = env.API_PUBLIC_URL;
    env.GOOGLE_REDIRECT_URI = undefined;
    env.API_PUBLIC_URL = 'https://api.pagent.link';
    try {
      const parsed = new URL(buildGoogleAuthUrl('signed-state-jwt'));
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://api.pagent.link/oauth/callback/google',
      );
    } finally {
      env.GOOGLE_REDIRECT_URI = originalRedirect;
      env.API_PUBLIC_URL = originalApiUrl;
    }
  });

  it('throws when GOOGLE_CLIENT_ID is not configured', () => {
    const original = env.GOOGLE_CLIENT_ID;
    (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = undefined;
    try {
      expect(() => buildGoogleAuthUrl('x')).toThrow(/GOOGLE_CLIENT_ID/);
    } finally {
      (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = original;
    }
  });
});

describe('exchangeGoogleCode', () => {
  it('accepts a verified Google email claim', async () => {
    const fetchSpy = await mockGoogleTokenResponse({
      sub: 'google-sub-verified',
      email: 'verified@example.test',
      email_verified: true,
    });

    await expect(exchangeGoogleCode('google-code')).resolves.toMatchObject({
      sub: 'google-sub-verified',
      email: 'verified@example.test',
    });
    fetchSpy.mockRestore();
  });

  it.each([
    ['missing', undefined],
    ['false', false],
    ['string true', 'true'],
  ])('rejects an email_verified claim that is %s', async (_label, emailVerified) => {
    const claims: Record<string, unknown> = {
      sub: 'google-sub-unverified',
      email: 'unverified@example.test',
    };
    if (emailVerified !== undefined) claims.email_verified = emailVerified;
    const fetchSpy = await mockGoogleTokenResponse(
      claims,
      emailVerified === undefined ? { includeDefaultEmailVerified: false } : {},
    );

    await expect(exchangeGoogleCode('google-code')).rejects.toThrow(/email_verified/);
    fetchSpy.mockRestore();
  });
});

describe('state JWT', () => {
  it('round-trip preserves every claim', async () => {
    const claims = {
      clientId: 'mcp-cli',
      redirectUri: 'http://localhost:9876/cb',
      codeChallenge: 'abc',
      scope: 'page:create page:read',
      state: 'csrf-state-from-client',
      browserTransactionHash: 'transaction-hash',
      consentGranted: true,
    };
    const token = await signStateJwt(claims);
    const decoded = await verifyStateJwt(token);
    expect(decoded).toEqual(claims);
  });

  it('round-trip preserves browser_session flag', async () => {
    const token = await signStateJwt({ browserSession: true });
    const decoded = await verifyStateJwt(token);
    expect(decoded.browserSession).toBe(true);
    expect(decoded.clientId).toBeUndefined();
  });

  it('rejects a tampered token (modified payload, original signature)', async () => {
    const token = await signStateJwt({ clientId: 'mcp-cli', redirectUri: 'http://x' });
    const [h, _p, s] = token.split('.');
    const evil = Buffer.from(
      JSON.stringify({
        client_id: 'mcp-cli',
        redirect_uri: 'http://attacker',
        iss: 'pagent:oauth:state',
      }),
    ).toString('base64url');
    const tampered = `${h}.${evil}.${s}`;
    await expect(verifyStateJwt(tampered)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = await signStateJwt({ clientId: 'mcp-cli' });
      vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
      await expect(verifyStateJwt(token)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token signed under a different secret', async () => {
    const token = await signStateJwt({ clientId: 'mcp-cli' });
    const original = env.AUTH_STATE_SECRET;
    (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET = 'different-secret';
    try {
      await expect(verifyStateJwt(token)).rejects.toThrow();
    } finally {
      (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET = original;
    }
  });
});

describe('renderLoginPage', () => {
  it('renders a complete HTML document with the Google link and email form', async () => {
    const state = await signStateJwt({ clientId: 'mcp-cli', redirectUri: 'http://x' });
    const html = renderLoginPage({ signedState: state, oauthAuthorization: true });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Sign in to Pagent</title>');
    expect(html).toContain('Allow and continue with Google');
    expect(html).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(html).toContain('<form method="POST" action="/oauth/magic/send"');
    expect(html).toContain(`value="${state}"`);
    expect(html).toContain('<input type="email"');
  });

  it('escapes the error message to prevent XSS', () => {
    const html = renderLoginPage({ error: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('omits the buttons when no signedState is supplied (hard error)', () => {
    const html = renderLoginPage({ error: 'Unknown client_id' });
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('<form method="POST"');
    expect(html).toContain('Unknown client_id');
  });
});

describe('renderConsentPage', () => {
  it('escapes self-asserted client metadata while preserving exact security details', () => {
    const html = renderConsentPage({
      signedState: 'signed-state',
      client: {
        id: 'client-<id>',
        name: '<script>Client</script>',
        redirectUri: 'https://client.example/callback?source=<oauth>',
        scope: 'page:create page:read',
      },
    });

    expect(html).not.toContain('<script>Client</script>');
    expect(html).toContain('&lt;script&gt;Client&lt;/script&gt;');
    expect(html).toContain('client-&lt;id&gt;');
    expect(html).toContain('https://client.example/callback?source=&lt;oauth&gt;');
    expect(html).toContain('<code>page:create</code>');
    expect(html).toContain('<code>page:read</code>');
  });
});
