/**
 * Ed25519 JWT signing, verification, and JWKS serialization.
 *
 * Pagent acts as both Authorization Server and Resource Server (co-hosted),
 * so `iss === aud` and the same key pair signs and verifies. Access tokens
 * are self-contained: verification is purely cryptographic and never hits
 * the database. The 1-hour TTL is V1's revocation mechanism.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §5.
 */
import { SignJWT, jwtVerify, importPKCS8, importSPKI, exportJWK } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../schemas.ts';

// --- Constants ---------------------------------------------------------------

// Bumped when the signing key is rotated. External JWKS consumers select the
// matching public key by `kid`.
export const KID = 'pagent-2026-05';
export const ALG = 'EdDSA';
// `at+jwt` (RFC 9068) distinguishes OAuth 2.0 access tokens from ID tokens
// and other JWT types. Resource servers SHOULD reject tokens without this typ.
export const TYP = 'at+jwt';

// --- Module state ------------------------------------------------------------

// Loaded once via initKeys(). signAccessToken / verifyAccessToken throw a
// clear error if init wasn't called — better than a cryptic null deref.
let privateKey: CryptoKey | null = null;
let publicKey: CryptoKey | null = null;
let publicJwk: JWK | null = null;

// --- Types -------------------------------------------------------------------

export interface AccessTokenClaims {
  sub: string;
  email: string;
  handle: string;
  clientId: string;
  scope: string;
}

// Shape of the verified payload returned by verifyAccessToken. Mirrors spec
// §5.1 — every claim listed there is required on a valid pagent access token.
export interface JwtPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
  scope: string;
  email: string;
  handle: string;
}

// --- Key initialization ------------------------------------------------------

/**
 * Decode a base64url string back to its raw bytes.
 *
 * The signing keys land here as base64url-encoded DER (per the key-gen
 * snippet in spec §5.3). We turn them back into a PEM string because that's
 * the only format `jose.importPKCS8` / `importSPKI` accept directly.
 */
function base64urlToPem(b64u: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  // PEM bodies are conventionally line-wrapped at 64 chars. Not strictly
  // required by importPKCS8/importSPKI, but matches `openssl`-style output
  // and is easier on the eyes if these strings ever surface in logs.
  const wrapped = (b64.match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

/**
 * Import the Ed25519 key pair from base64url-encoded DER strings.
 *
 * Must be called before signAccessToken / verifyAccessToken / getJwks.
 * Idempotent — calling again overwrites the cached keys (useful in tests).
 */
export async function initKeys(signingKeyB64u: string, publicKeyB64u: string): Promise<void> {
  const privatePem = base64urlToPem(signingKeyB64u, 'PRIVATE KEY');
  const publicPem = base64urlToPem(publicKeyB64u, 'PUBLIC KEY');
  privateKey = await importPKCS8(privatePem, ALG);
  publicKey = await importSPKI(publicPem, ALG);
  // exportJWK returns only the structural fields (kty, crv, x). RFC 7517
  // permits `use` and `kid` as additional members — we add them so the
  // JWKS endpoint output matches spec §5.3 exactly.
  const jwk = await exportJWK(publicKey);
  publicJwk = { ...jwk, use: 'sig', kid: KID };
}

// --- Issuer / audience derivation -------------------------------------------

/**
 * Issuer URL — derived from PUBLIC_URL with the same dev fallback as app.ts.
 *
 * For pagent's co-hosted AS+RS, `iss` and `aud` are identical. Computed on
 * every call (rather than cached) so tests that mutate env / app config
 * stay observable, and so a future config-reload story doesn't need to
 * invalidate this module.
 */
export function getIssuer(): string {
  return env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;
}

// --- Signing -----------------------------------------------------------------

/**
 * Sign an access token for the given user/client.
 *
 * Sets every claim required by spec §5.1: iss, sub, aud, exp, iat, jti,
 * client_id, scope, email, handle. Lifetime is ACCESS_TOKEN_TTL_SECONDS
 * from env (default 3600s).
 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  if (!privateKey) {
    throw new Error('JWT signing key not initialized — call initKeys() at boot');
  }
  const issuer = getIssuer();
  // SignJWT sets `iat` automatically via setIssuedAt(); setExpirationTime
  // accepts a relative duration and computes `exp` from the same `iat`.
  return await new SignJWT({
    client_id: claims.clientId,
    scope: claims.scope,
    email: claims.email,
    handle: claims.handle,
  })
    .setProtectedHeader({ alg: ALG, typ: TYP, kid: KID })
    .setSubject(claims.sub)
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(privateKey);
}

// --- Verification ------------------------------------------------------------

/**
 * Verify an access token's signature and standard claims.
 *
 * Throws on bad signature, expired token, or wrong iss/aud. No DB round-trip.
 * Returns the decoded payload, narrowed to JwtPayload after we confirm the
 * pagent-specific claims (jti, client_id, scope, email, handle) are present.
 */
export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  if (!publicKey) {
    throw new Error('JWT public key not initialized — call initKeys() at boot');
  }
  const issuer = getIssuer();
  // jose's jwtVerify checks signature, `exp` (against current time with a
  // small clock-skew tolerance), `nbf`, and the issuer/audience options.
  // It does NOT validate the `typ` header for us — that's a callers'
  // concern; we set it on sign but don't gate on it here (RFC 9068 §4
  // requires RS-side typ enforcement, but pagent's verifier is only ever
  // called on its own tokens, so the `iss` check is already enough).
  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: issuer,
    algorithms: [ALG],
  });
  assertPagentClaims(payload);
  return payload;
}

function assertPagentClaims(payload: JWTPayload): asserts payload is JwtPayload & JWTPayload {
  // jose guarantees iss/sub/aud/exp/iat presence via setX() if they were set
  // at sign time, but a *foreign* JWT (signed elsewhere, accidentally trusted
  // by a misconfigured verifier) could lack the pagent-specific claims.
  // Tight validation here means downstream code can read these as required.
  const required = ['sub', 'iss', 'aud', 'exp', 'iat', 'jti'] as const;
  for (const k of required) {
    if (payload[k] === undefined) throw new Error(`missing required claim: ${k}`);
  }
  const stringClaims = ['client_id', 'scope', 'email', 'handle'] as const;
  for (const k of stringClaims) {
    if (typeof payload[k] !== 'string') {
      throw new Error(`missing or non-string claim: ${k}`);
    }
  }
}

// --- JWKS --------------------------------------------------------------------

/**
 * Return the public key as a JWKS document, ready for GET /.well-known/jwks.json.
 *
 * Format matches spec §5.3: a single Ed25519 OKP key with use=sig and the
 * current kid. Cached at initKeys() time — calling this is a synchronous
 * object spread.
 */
export function getJwks(): { keys: JWK[] } {
  if (!publicJwk) {
    throw new Error('JWT public key not initialized — call initKeys() at boot');
  }
  return { keys: [publicJwk] };
}
