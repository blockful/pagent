import { createHash, generateKeyPairSync } from 'node:crypto';

export const CLIENT_ID = 'a1b2c3d4-e5f6-4321-9876-abcdef012345';
export const REDIRECT_URI = 'http://localhost:9876/callback';
export const SCOPE = 'page:create page:read';

export const CLIENT_INFO = Object.freeze({
  client_id: CLIENT_ID,
  client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});

export const USER_ROW = Object.freeze({
  id: '11111111-2222-3333-4444-555555555555',
  handle: 'alex',
  email: 'alex@blockful.io',
  name: 'Alex',
  avatar_url: null,
  created_at: new Date('2026-05-01T00:00:00Z'),
  updated_at: new Date('2026-05-01T00:00:00Z'),
});

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function initializeTestKeys(
  initialize: (privateKey: string, publicKey: string) => Promise<void>,
): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await initialize(
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  );
}
