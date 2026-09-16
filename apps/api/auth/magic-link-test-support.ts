import { createHash, generateKeyPairSync } from 'node:crypto';
import { beforeAll, beforeEach, vi } from 'vitest';

import { env } from '../schemas.ts';
import { initKeys } from './jwt.ts';
import { magicSendGlobalLimiter, magicSendIpLimiter, magicSendLimiter } from './routes.ts';

export const BASE = 'http://localhost';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function postMagicSend(
  body: Record<string, string>,
  opts: {
    contentType?: 'json' | 'form';
    cookie?: string;
    realIp?: string;
    forwardedFor?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.realIp !== undefined) headers['X-Real-IP'] = opts.realIp;
  if (opts.forwardedFor !== undefined) headers['X-Forwarded-For'] = opts.forwardedFor;
  let serialized: string;
  if (opts.contentType === 'form' || opts.contentType === undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    serialized = new URLSearchParams(body).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    serialized = JSON.stringify(body);
  }
  return new Request(`${BASE}/oauth/magic/send`, {
    method: 'POST',
    headers,
    body: serialized,
  });
}

export const clientRow = {
  client_id: 'a1b2c3d4-e5f6-4321-9876-abcdef012345',
  client_secret: null,
  client_secret_expires_at: null,
  client_id_issued_at: new Date('2026-05-17T12:00:00Z'),
  client_name: 'Claude Code',
  client_uri: null,
  logo_uri: null,
  redirect_uris: ['http://localhost:9876/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: null,
  token_endpoint_auth_method: 'none',
};

export function setupMagicLinkTest(): void {
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await initKeys(
      privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    );
    (env as { SMTP_HOST: string | undefined }).SMTP_HOST = 'smtp.test.example';
    (env as { SMTP_USER: string | undefined }).SMTP_USER = 'test-user';
    (env as { SMTP_PASS: string | undefined }).SMTP_PASS = 'test-pass';
    (env as { AUTH_STATE_SECRET: string | undefined }).AUTH_STATE_SECRET =
      'test-auth-state-secret-very-long-random-value-32-bytes';
    (env as { PUBLIC_URL: string | undefined }).PUBLIC_URL = 'http://localhost:8787';
    env.API_PUBLIC_URL = 'https://api.pagent.link';
  });

  beforeEach(() => {
    vi.clearAllMocks();
    magicSendLimiter.reset();
    magicSendIpLimiter.reset();
    magicSendGlobalLimiter.reset();
  });
}
