/**
 * HMAC-SHA256 state JWT for the Google OAuth round-trip.
 *
 * The `state` query parameter we send to Google encodes the full MCP-client
 * authorize request (client_id, redirect_uri, code_challenge, scope, and the
 * client's own CSRF state). When Google calls /oauth/callback/google we can
 * resume the flow from the JWT alone — no server-side cache needed.
 *
 * Signed (not encrypted) is sufficient: every field is information the
 * client already provided, an attacker doesn't gain anything by reading
 * them. Tampering is what we have to prevent (e.g. swapping redirect_uri),
 * and HMAC-SHA256 with AUTH_STATE_SECRET catches that.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §4.2 (state encoding),
 * §7.7 (security rationale).
 */
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../schemas.ts';

// 15-minute expiry mirrors the auth-code TTL — the user shouldn't be stuck on
// Google's consent screen for longer than that in practice, and a longer
// window would just extend the window in which a stolen state JWT is useful.
const STATE_TTL_SECONDS = 15 * 60;

// HS256 is the standard symmetric JWT alg. AUTH_STATE_SECRET is a shared
// random value (e.g. `openssl rand -base64 32`) — distinct from the magic
// link secret so a leak of one doesn't compromise the other.
const ALG = 'HS256';

// jose's verify rejects iss/aud mismatches; pinning them ensures a magic-link
// HMAC token can't be cross-used here even if MAGIC_LINK_SECRET were ever
// (incorrectly) set to the same value as AUTH_STATE_SECRET.
const ISS = 'pagent:oauth:state';
const AUD = 'pagent:oauth:callback';

/**
 * The encoded authorize-request context. All fields are optional because the
 * browser_session path (no MCP client, just a session cookie) doesn't carry
 * any of the PKCE bits — only `browserSession: true` survives the round-trip.
 */
export interface StateClaims {
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  scope?: string;
  state?: string;
  browserSession?: boolean;
}

function getKey(): Uint8Array {
  if (!env.AUTH_STATE_SECRET) {
    throw new Error(
      'AUTH_STATE_SECRET is not configured — auth endpoints unavailable. See docs/superpowers/specs/2026-05-17-auth-design.md §9.',
    );
  }
  // Buffer extends Uint8Array, but typing the return as Uint8Array is more
  // honest about what jose accepts and avoids leaking node-specific types
  // into the auth surface.
  return new Uint8Array(Buffer.from(env.AUTH_STATE_SECRET, 'utf-8'));
}

/**
 * Sign a state JWT containing the authorize-request context.
 *
 * Each field is emitted only when present so a roundtrip preserves the exact
 * shape of the input (a verify-then-sign loop wouldn't add stray nulls).
 */
export async function signStateJwt(claims: StateClaims): Promise<string> {
  const payload: Record<string, unknown> = {};
  if (claims.clientId !== undefined) payload.client_id = claims.clientId;
  if (claims.redirectUri !== undefined) payload.redirect_uri = claims.redirectUri;
  if (claims.codeChallenge !== undefined) payload.code_challenge = claims.codeChallenge;
  if (claims.scope !== undefined) payload.scope = claims.scope;
  if (claims.state !== undefined) payload.state = claims.state;
  if (claims.browserSession !== undefined) payload.browser_session = claims.browserSession;
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(getKey());
}

/**
 * Verify a state JWT and return the decoded claims.
 *
 * Throws on bad signature, expired token, or wrong iss/aud. Caller is
 * responsible for surfacing the failure mode to the user (typically: render
 * the login page with an error message — the original authorize parameters
 * are unrecoverable at this point, so the user re-initiates from their
 * MCP client).
 */
export async function verifyStateJwt(token: string): Promise<StateClaims> {
  const { payload } = await jwtVerify(token, getKey(), {
    issuer: ISS,
    audience: AUD,
    algorithms: [ALG],
  });
  const out: StateClaims = {};
  if (typeof payload.client_id === 'string') out.clientId = payload.client_id;
  if (typeof payload.redirect_uri === 'string') out.redirectUri = payload.redirect_uri;
  if (typeof payload.code_challenge === 'string') out.codeChallenge = payload.code_challenge;
  if (typeof payload.scope === 'string') out.scope = payload.scope;
  if (typeof payload.state === 'string') out.state = payload.state;
  if (typeof payload.browser_session === 'boolean') out.browserSession = payload.browser_session;
  return out;
}
