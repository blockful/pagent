import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { beforeAll, vi } from 'vitest';

vi.mock('../db.ts', () => ({
  init: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  insertPage: vi.fn(() => Promise.resolve()),
  getActivePage: vi.fn(() => Promise.resolve(null)),
  submitPage: vi.fn(() => Promise.resolve({ kind: 'not_found' })),
  fetchAndAdvanceResult: vi.fn(() => Promise.resolve(null)),
  deletePage: vi.fn(() => Promise.resolve()),
  deleteExpiredPages: vi.fn(() => Promise.resolve({ total: 0, abandoned: 0 })),
  deleteExpiredAuthArtifacts: vi.fn(() =>
    Promise.resolve({ sessions: 0, authCodes: 0, magicLinks: 0, refreshTokens: 0, total: 0 }),
  ),
  ping: vi.fn().mockResolvedValue(undefined),
  insertOAuthClient: vi.fn(),
  getOAuthClientById: vi.fn(),
  upsertUser: vi.fn(),
  upsertGoogleUser: vi.fn(),
  getUserByHandle: vi.fn(),
  getUserById: vi.fn(),
  insertAuthCode: vi.fn(),
  consumeAuthCodeAndInsertRefreshToken: vi.fn(),
  getAuthCodeForReplay: vi.fn(),
  insertRefreshToken: vi.fn(),
  getRefreshTokenByHash: vi.fn(),
  revokeRefreshToken: vi.fn(),
  revokeAllRefreshTokensForFamily: vi.fn(),
  insertSession: vi.fn(() => Promise.resolve()),
  getSessionWithUserByTokenHash: vi.fn(() => Promise.resolve(null)),
  extendSessionExpiry: vi.fn(() => Promise.resolve()),
  deleteSessionByTokenHash: vi.fn(() => Promise.resolve()),
  insertMagicLink: vi.fn(() => Promise.resolve()),
  getActiveMagicLink: vi.fn(() => Promise.resolve(null)),
  verifyAndConsumeMagicLink: vi.fn(() => Promise.resolve(null)),
}));

import * as databaseMock from '../db.ts';
import type { RequestIdVariables } from '../request-id.ts';
import { authRoutes } from './routes.ts';
import { initKeys } from './jwt.ts';
import type { AuthVariables } from './middleware.ts';
import { resolveAuth, SESSION_COOKIE_NAME as sessionCookieName } from './middleware.ts';

export const db = databaseMock;
export const SESSION_COOKIE_NAME = sessionCookieName;

export const BASE = 'http://localhost';
export const NOW = new Date('2026-05-17T12:00:00Z');

export const app = new Hono<{ Variables: RequestIdVariables & AuthVariables }>();
app.use('*', resolveAuth());
app.route('/', authRoutes);

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signingKeyB64u = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  const publicKeyB64u = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  await initKeys(signingKeyB64u, publicKeyB64u);
});

export async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}
