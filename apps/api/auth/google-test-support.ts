import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import { vi } from 'vitest';
import { env } from '../schemas.ts';
import { initKeys } from './jwt.ts';

export const BASE = 'http://localhost';
export const GOOGLE_KID = 'test-google-kid';

export const VALID_AUTHORIZE = {
  response_type: 'code',
  client_id: 'a1b2c3d4-e5f6-4321-9876-abcdef012345',
  redirect_uri: 'http://localhost:9876/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  scope: 'page:create page:read',
  state: 'mcp-client-csrf-state',
} as const;

export const clientRow = {
  client_id: VALID_AUTHORIZE.client_id,
  client_secret: null,
  client_secret_expires_at: null,
  client_id_issued_at: new Date('2026-05-17T12:00:00Z'),
  client_name: 'Claude Code',
  client_uri: null,
  logo_uri: null,
  redirect_uris: [VALID_AUTHORIZE.redirect_uri],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: null,
  token_endpoint_auth_method: 'none',
};

let googleKeyPair: { publicKey: KeyObject; privateKey: KeyObject };
let googleJwks: { keys: unknown[] };

export async function setupGoogleAuthTest(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await initKeys(
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  );
  (env as { GOOGLE_CLIENT_ID: string | undefined }).GOOGLE_CLIENT_ID = 'test-google-client-id';
  (env as { GOOGLE_CLIENT_SECRET: string | undefined }).GOOGLE_CLIENT_SECRET =
    'test-google-client-secret';
  (env as { GOOGLE_REDIRECT_URI: string | undefined }).GOOGLE_REDIRECT_URI =
    'http://localhost/oauth/callback/google';
  (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET =
    'test-auth-state-secret-very-long-random-value-32-bytes';

  googleKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(googleKeyPair.publicKey);
  googleJwks = {
    keys: [{ ...publicJwk, alg: 'RS256', use: 'sig', kid: GOOGLE_KID }],
  };
}

export function authorizeUrl(params: Record<string, string>): string {
  return `${BASE}/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

async function makeSignedIdToken(
  claims: Record<string, unknown>,
  overrides: {
    iss?: string;
    aud?: string;
    expSeconds?: number;
    includeDefaultEmailVerified?: boolean;
  } = {},
): Promise<string> {
  const issuer = overrides.iss ?? 'https://accounts.google.com';
  const audience = overrides.aud ?? 'test-google-client-id';
  const ttl = overrides.expSeconds ?? 600;
  const signedClaims =
    overrides.includeDefaultEmailVerified === false ? claims : { email_verified: true, ...claims };
  return await new SignJWT(signedClaims)
    .setProtectedHeader({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(googleKeyPair.privateKey);
}

export async function mockGoogleTokenResponse(
  idTokenClaims: Record<string, unknown>,
  options: {
    iss?: string;
    aud?: string;
    expSeconds?: number;
    includeDefaultEmailVerified?: boolean;
  } = {},
) {
  const idToken = await makeSignedIdToken(idTokenClaims, options);
  return vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ id_token: idToken, access_token: 'g-at' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('googleapis.com/oauth2/v3/certs')) {
      return new Response(JSON.stringify(googleJwks), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}
