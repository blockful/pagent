/**
 * Google OAuth 2.0 client — authorize URL builder + code-for-token exchange.
 *
 * Pagent is a relying party to Google: the user clicks "Continue with Google"
 * on our login page, the browser hits Google's consent screen, and on
 * approval Google redirects to /oauth/callback/google with an authorization
 * code. We exchange that code at https://oauth2.googleapis.com/token for an
 * ID token (JWT) carrying the user's `sub`, `email`, `name`, and `picture`.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §4.2 (Google OAuth
 * flow), §3.7 (callback endpoint).
 */
import { decodeJwt } from 'jose';
import { env } from '../schemas.ts';

// Google's documented OAuth 2.0 endpoints. v2/auth is the modern consent
// screen; oauth2.googleapis.com/token is the universal token endpoint. Both
// are stable URLs published in Google's OIDC discovery document.
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// The three OIDC scopes Pagent needs: `openid` makes Google emit an ID token
// (without it the response is bare oauth without identity claims); `email`
// and `profile` populate the `email`, `name`, `picture` claims we read in
// the callback. We never request offline_access — Pagent doesn't store
// Google refresh tokens.
const GOOGLE_SCOPES = 'openid email profile';

/**
 * The fields we extract from Google's ID token. Matches the OIDC standard
 * claims for the requested scopes (`openid email profile`).
 *
 * `sub` is Google's stable per-user identifier — never reused, never
 * mutates. We don't currently persist it (email is our natural key), but
 * a future "link this account to another login method" flow would need it.
 */
export interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Returns the absolute redirect_uri sent to Google. Defaults to
 * `${PUBLIC_URL}/oauth/callback/google` when GOOGLE_REDIRECT_URI is unset
 * — matches the .env.example default and keeps dev/prod parity automatic.
 */
function getRedirectUri(): string {
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
  const base = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;
  return `${base}/oauth/callback/google`;
}

/**
 * Build the URL we redirect the user's browser to after they click "Continue
 * with Google". Caller passes the state JWT — we don't sign it here so the
 * builder stays a pure URL string operation suitable for tests and the
 * route handler alike.
 *
 * Throws if GOOGLE_CLIENT_ID is unset. The auth routes return 503 in that
 * case before reaching this builder, but the explicit throw protects against
 * a future call site that forgets the env check.
 */
export function buildGoogleAuthUrl(state: string): string {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error(
      'GOOGLE_CLIENT_ID is not configured — Google login unavailable. See docs/superpowers/specs/2026-05-17-auth-design.md §9.',
    );
  }
  // URLSearchParams emits the canonical x-www-form-urlencoded form Google
  // expects (spaces as `+`, no leading `?`). We prepend `?` once at the
  // end so the resulting URL is suitable for a `Location` header or
  // `<a href>` value.
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state,
    // Force consent prompt on first-time users; subsequent logins will be
    // silent. `select_account` lets users pick which Google account to use
    // when they have multiple signed in. Combination matches what most
    // OIDC RPs use.
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange Google's authorization code for an ID token, then decode the ID
 * token's claims.
 *
 * Note on signature verification: in production we'd verify the ID token's
 * signature against Google's JWKS (https://www.googleapis.com/oauth2/v3/certs)
 * via `createRemoteJWKSet`. Here we use `decodeJwt` (unsafe decode, no
 * signature check) because we trust the TLS connection to oauth2.googleapis.com
 * — the token came directly from Google over HTTPS, not via a third party.
 * Production hardening (full JWKS verification) is a follow-up.
 */
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured — Google login unavailable.',
    );
  }
  // Google's token endpoint mandates application/x-www-form-urlencoded.
  // URLSearchParams.toString() is the right shape; fetch sets the content-type
  // header automatically when the body is a URLSearchParams instance.
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    // Google returns a JSON error body (e.g. `{ "error": "invalid_grant" }`)
    // on auth failures. We surface the status + body text so the route layer
    // can log enough detail to debug a misconfigured client without echoing
    // it to the end user.
    const text = await res.text().catch(() => '');
    throw new Error(
      `google token exchange failed: status=${res.status} body=${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    throw new Error('google token response missing id_token');
  }
  // decodeJwt skips signature verification — see the note above. Returns
  // the payload as a generic JWTPayload; we narrow it to the OIDC claims we
  // expect from the `openid email profile` scope set.
  const claims = decodeJwt(json.id_token);
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('google id_token missing sub claim');
  }
  if (typeof claims.email !== 'string' || claims.email.length === 0) {
    throw new Error('google id_token missing email claim');
  }
  const profile: GoogleProfile = {
    sub: claims.sub,
    email: claims.email,
  };
  if (typeof claims.name === 'string' && claims.name.length > 0) {
    profile.name = claims.name;
  }
  if (typeof claims.picture === 'string' && claims.picture.length > 0) {
    profile.picture = claims.picture;
  }
  return profile;
}
