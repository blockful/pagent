/**
 * JWT module unit tests — pure crypto, no I/O, no DB.
 *
 * Test keys are generated in-process via node:crypto.generateKeyPairSync and
 * fed to initKeys() directly. We never set JWT_SIGNING_KEY / JWT_PUBLIC_KEY
 * on process.env — the schema-level env var contract is exercised in
 * schemas.test.ts; here we only validate the cryptographic primitives.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import {
  ALG,
  KID,
  TYP,
  initKeys,
  signAccessToken,
  verifyAccessToken,
  getJwks,
  getIssuer,
} from './jwt.ts';
import { decodeJwt, decodeProtectedHeader } from 'jose';

// --- Test setup --------------------------------------------------------------

const SAMPLE_CLAIMS = {
  sub: '11111111-2222-3333-4444-555555555555',
  email: 'alex@blockful.io',
  handle: 'alex',
  clientId: 'mcp-cli',
  scope: 'page:create page:read',
};

function generateTestKeyEnv(): { signingKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    signingKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

beforeAll(async () => {
  const { signingKey, publicKey } = generateTestKeyEnv();
  await initKeys(signingKey, publicKey);
});

afterEach(() => {
  // db.test.ts uses fake timers in its own describe blocks; we follow the
  // same hygiene — anything that flips to fake timers must restore real ones.
  vi.useRealTimers();
});

// --- Round-trip --------------------------------------------------------------

describe('signAccessToken / verifyAccessToken', () => {
  it('signs a token whose header is alg=EdDSA, typ=at+jwt, kid=pagent-2026-05', async () => {
    const token = await signAccessToken(SAMPLE_CLAIMS);
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe(ALG);
    expect(header.typ).toBe(TYP);
    expect(header.kid).toBe(KID);
  });

  it('round-trip: sign then verify returns every original claim', async () => {
    const token = await signAccessToken(SAMPLE_CLAIMS);
    const payload = await verifyAccessToken(token);
    const issuer = getIssuer();
    expect(payload.iss).toBe(issuer);
    expect(payload.aud).toBe(issuer);
    expect(payload.sub).toBe(SAMPLE_CLAIMS.sub);
    expect(payload.email).toBe(SAMPLE_CLAIMS.email);
    expect(payload.handle).toBe(SAMPLE_CLAIMS.handle);
    expect(payload.client_id).toBe(SAMPLE_CLAIMS.clientId);
    expect(payload.scope).toBe(SAMPLE_CLAIMS.scope);
  });

  it('sets exp to iat + ACCESS_TOKEN_TTL_SECONDS (default 3600)', async () => {
    const token = await signAccessToken(SAMPLE_CLAIMS);
    const payload = await verifyAccessToken(token);
    // Default ACCESS_TOKEN_TTL_SECONDS is 3600 from env schema. Tolerance of
    // ±1 second covers the integer-boundary case where iat ticks across a
    // second between SignJWT setting iat and reading payload here.
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it('generates a unique jti on every call', async () => {
    const a = await signAccessToken(SAMPLE_CLAIMS);
    const b = await signAccessToken(SAMPLE_CLAIMS);
    const pa = decodeJwt(a);
    const pb = decodeJwt(b);
    expect(pa.jti).toBeDefined();
    expect(pb.jti).toBeDefined();
    expect(pa.jti).not.toBe(pb.jti);
  });

  it('rejects an expired token', async () => {
    // Sign at t=0, then jump 2 hours into the future — well past the 1h TTL.
    // Fake timers must wrap both calls because SignJWT reads Date.now() for
    // iat and jose's verify also reads it for the exp check.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await signAccessToken(SAMPLE_CLAIMS);
    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token with a tampered payload', async () => {
    const token = await signAccessToken(SAMPLE_CLAIMS);
    // Modify the payload segment: decode, mutate sub, re-encode without
    // re-signing. Signature verification must fail.
    const [headerB64, , sigB64] = token.split('.');
    const original = decodeJwt(token);
    const tamperedPayload = { ...original, sub: '00000000-0000-0000-0000-000000000000' };
    const newPayloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
    const tampered = `${headerB64}.${newPayloadB64}.${sigB64}`;
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it('rejects a token signed by a different key (wrong signature)', async () => {
    // Sign with the live key, swap in a fresh key pair, attempt to verify.
    // Exercises the signature-mismatch path directly (the "tampered" test
    // covers the payload-mutation case). Tests within this file are
    // order-independent, so no need to restore the original key pair.
    const goodToken = await signAccessToken(SAMPLE_CLAIMS);
    const { signingKey, publicKey } = generateTestKeyEnv();
    await initKeys(signingKey, publicKey);
    await expect(verifyAccessToken(goodToken)).rejects.toThrow();
  });

  it('rejects a token with the wrong issuer', async () => {
    // Sign normally, then temporarily override env.PUBLIC_URL by stubbing
    // getIssuer. Easier: sign with current iss, then verify after rotating
    // env.PUBLIC_URL. Since getIssuer reads env on every call, mutating
    // env.PUBLIC_URL changes what verifyAccessToken expects.
    const token = await signAccessToken(SAMPLE_CLAIMS);
    // Grab the env module to flip PUBLIC_URL — it's a Zod-parsed object so
    // we mutate the in-memory copy directly.
    const { env } = await import('../schemas.ts');
    const original = env.PUBLIC_URL;
    (env as { PUBLIC_URL: string | undefined }).PUBLIC_URL = 'https://impostor.example.com';
    try {
      await expect(verifyAccessToken(token)).rejects.toThrow();
    } finally {
      (env as { PUBLIC_URL: string | undefined }).PUBLIC_URL = original;
    }
  });

  it('rejects a malformed token', async () => {
    await expect(verifyAccessToken('not.a.jwt')).rejects.toThrow();
    await expect(verifyAccessToken('')).rejects.toThrow();
  });
});

// --- JWKS --------------------------------------------------------------------

describe('getJwks', () => {
  it('returns a single Ed25519 OKP key with use=sig and the current kid', () => {
    const jwks = getJwks();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0];
    expect(key.kty).toBe('OKP');
    expect(key.crv).toBe('Ed25519');
    expect(key.use).toBe('sig');
    expect(key.kid).toBe(KID);
    // `x` is the base64url-encoded raw public key (32 bytes → 43 base64url chars).
    expect(typeof key.x).toBe('string');
    expect(key.x?.length).toBe(43);
    // No private-key material should leak in the public JWKS — `d` is the
    // Ed25519 seed, must never appear in a public JWK.
    expect(key.d).toBeUndefined();
  });
});

// --- Init guards -------------------------------------------------------------

describe('initKeys re-init', () => {
  it('re-initializing with a new key pair invalidates tokens from the old one', async () => {
    const tokenFromOldKey = await signAccessToken(SAMPLE_CLAIMS);
    const { signingKey, publicKey } = generateTestKeyEnv();
    await initKeys(signingKey, publicKey);
    await expect(verifyAccessToken(tokenFromOldKey)).rejects.toThrow();
    // New token signed under the new key still round-trips.
    const tokenFromNewKey = await signAccessToken(SAMPLE_CLAIMS);
    const payload = await verifyAccessToken(tokenFromNewKey);
    expect(payload.sub).toBe(SAMPLE_CLAIMS.sub);
  });
});
