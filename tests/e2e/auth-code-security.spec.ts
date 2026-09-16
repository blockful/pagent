import { createHash, randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import * as db from '../../apps/api/db.ts';
import { startProductionAuthServer } from './auth-test-support.ts';

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
});
const errorResponseSchema = z.object({ error: z.string() });

test('invalid PKCE cannot consume a valid authorization code', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');

  let api: APIRequestContext | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  await db.init(databaseUrl);
  try {
    // Given: a production server and an unconsumed code bound to a PKCE verifier.
    const runId = randomUUID();
    const clientId = randomUUID();
    const redirectUri = `https://client.example/callback/${runId}`;
    const code = `e2e-auth-code-${runId}`;
    const verifier = `e2e-verifier-${runId}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const user = await db.upsertUser({
      email: `auth-code-security-${runId}@example.test`,
      name: 'Auth code security E2E',
      avatarUrl: null,
      handle: `auth-code-${runId}`,
    });
    await db.insertOAuthClient({
      client_id: clientId,
      client_name: 'Auth code security E2E',
      client_uri: null,
      logo_uri: null,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'page:create',
      token_endpoint_auth_method: 'none',
    });
    await db.insertAuthCode({
      code,
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'page:create',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const server = await startProductionAuthServer(databaseUrl);
    stopServer = server.stop;
    api = await request.newContext({ baseURL: server.localUrl });

    // When: an attacker submits the code with a wrong verifier.
    const invalid = await api.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: `${verifier}-wrong`,
      },
    });

    // Then: the rejection leaves the code usable once, and replay still revokes its token family.
    expect(invalid.status()).toBe(400);
    expect(errorResponseSchema.parse(await invalid.json()).error).toBe('invalid_grant');
    expect(await db.getAuthCodeForReplay(code)).toMatchObject({ consumed_at: null });

    const valid = await api.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    });
    expect(valid.status()).toBe(200);
    const tokens = tokenResponseSchema.parse(await valid.json());
    expect(await db.getAuthCodeForReplay(code)).toMatchObject({ consumed_at: expect.any(Date) });

    const replay = await api.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    });
    expect(replay.status()).toBe(400);
    const refreshHash = createHash('sha256').update(tokens.refresh_token).digest('hex');
    expect(await db.getRefreshTokenByHash(refreshHash)).toMatchObject({
      revoked_at: expect.any(Date),
    });
  } finally {
    await api?.dispose();
    await stopServer?.();
    await db.shutdown();
  }
});
