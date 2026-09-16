import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import * as db from '../../apps/api/db.ts';
import { startProductionAuthServer } from './auth-test-support.ts';

const tokenResponseSchema = z.object({ refresh_token: z.string() });

test('a replayed old grant cannot revoke a later authorization grant for the same client', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');

  let api: APIRequestContext | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const clientId = randomUUID();
    const redirectUri = `https://client.example/callback/${runId}`;
    const user = await db.upsertUser({
      email: `refresh-family-${runId}@example.test`,
      name: 'Refresh family security E2E',
      avatarUrl: null,
      handle: `refresh-family-${runId}`,
    });
    await db.insertOAuthClient({
      client_id: clientId,
      client_name: 'Refresh family security E2E',
      client_uri: null,
      logo_uri: null,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'page:create',
      token_endpoint_auth_method: 'none',
    });

    const staleRefreshToken = `rt_${randomBytes(32).toString('hex')}`;
    const staleFamilyId = randomUUID();
    const stale = await db.insertRefreshToken({
      userId: user.id,
      clientId,
      familyId: staleFamilyId,
      tokenHash: createHash('sha256').update(staleRefreshToken).digest('hex'),
      scope: 'page:create',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await db.revokeRefreshToken(stale.id);

    const code = `refresh-family-code-${runId}`;
    const verifier = `refresh-family-verifier-${runId}`;
    await db.insertAuthCode({
      code,
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      scope: 'page:create',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const server = await startProductionAuthServer(databaseUrl);
    stopServer = server.stop;
    api = await request.newContext({ baseURL: server.localUrl });
    const freshGrant = await api.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    });
    expect(freshGrant.status()).toBe(200);
    const freshTokens = tokenResponseSchema.parse(await freshGrant.json());
    const fresh = await db.getRefreshTokenByHash(
      createHash('sha256').update(freshTokens.refresh_token).digest('hex'),
    );
    if (fresh === null)
      throw new TypeError('Authorization-code exchange did not persist a refresh token');
    expect(fresh.family_id).not.toBe(staleFamilyId);

    const replay = await api.post('/oauth/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: staleRefreshToken,
        client_id: clientId,
      },
    });

    expect(replay.status()).toBe(400);
    await expect(db.getRefreshTokenByHash(fresh.token_hash)).resolves.toMatchObject({
      id: fresh.id,
      revoked_at: null,
    });
  } finally {
    await api?.dispose();
    await stopServer?.();
    await db.shutdown();
  }
});
