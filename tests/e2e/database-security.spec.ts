import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import * as db from '../../apps/api/db.ts';
import { upsertUser as upsertAuthUser } from '../../apps/api/auth/user-provider.ts';

test.describe.configure({ mode: 'serial' });

test('upserts case-variant emails into one canonical user', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const mixedCaseEmail = `Case-${runId}@Example.TEST`;
    const original = await db.upsertUser({
      email: mixedCaseEmail,
      name: 'Original',
      avatarUrl: null,
      handle: `case-${runId}`,
    });
    const updated = await db.upsertUser({
      email: mixedCaseEmail.toLowerCase(),
      name: 'Updated',
      avatarUrl: null,
      handle: `replacement-${runId}`,
    });

    expect(updated.id).toBe(original.id);
    expect(updated.handle).toBe(original.handle);
    expect(updated.email).toBe(mixedCaseEmail.toLowerCase());
    expect(updated.name).toBe('Updated');
  } finally {
    await db.shutdown();
  }
});

test('allocates distinct handles when signups with the same local part race', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const localPart = `race-${randomUUID()}`;
    const users = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        upsertAuthUser({ email: `${localPart}@example-${index}.test` }),
      ),
    );

    expect(new Set(users.map((user) => user.id)).size).toBe(4);
    expect(new Set(users.map((user) => user.handle)).size).toBe(4);
  } finally {
    await db.shutdown();
  }
});

async function createTokenFamily() {
  const runId = randomUUID();
  const clientId = `e2e-client-${runId}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const user = await db.upsertUser({
    email: `database-security-${runId}@example.com`,
    name: 'Database security test',
    avatarUrl: null,
    handle: `db-security-${runId}`,
  });
  await db.insertOAuthClient({
    client_id: clientId,
    client_name: 'Database security test',
    client_uri: null,
    logo_uri: null,
    redirect_uris: [`https://example.com/callback/${runId}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'openid',
    token_endpoint_auth_method: 'none',
  });
  const oldToken = await db.insertRefreshToken({
    userId: user.id,
    clientId,
    tokenHash: `e2e-old-${runId}`,
    scope: 'openid',
    expiresAt,
  });
  return { clientId, expiresAt, oldToken, runId, user };
}

test('allows exactly one successor when concurrent refresh-token rotations race', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new TypeError('DATABASE_URL is required for the PostgreSQL security test');
  }

  await db.init(databaseUrl);
  try {
    // Given: one active refresh token bound to a unique user and OAuth client.
    const { clientId, expiresAt, oldToken, runId, user } = await createTokenFamily();
    const successorAHash = `e2e-successor-a-${runId}`;
    const successorBHash = `e2e-successor-b-${runId}`;

    // When: two callers concurrently try to rotate the same active token.
    const results = await Promise.all([
      db.rotateRefreshToken(oldToken.id, {
        tokenHash: successorAHash,
        scope: 'openid',
        expiresAt,
      }),
      db.rotateRefreshToken(oldToken.id, {
        tokenHash: successorBHash,
        scope: 'openid',
        expiresAt,
      }),
    ]);

    // Then: exactly one successor exists, and family revocation reaches it.
    const successors = results.filter((result) => result !== null);
    expect(successors).toHaveLength(1);
    const winner = successors[0];
    expect(winner).toBeDefined();
    if (winner === undefined) {
      throw new TypeError('refresh-token race did not produce a winner');
    }

    const successorA = await db.getRefreshTokenByHash(successorAHash);
    const successorB = await db.getRefreshTokenByHash(successorBHash);
    expect([successorA, successorB].filter((row) => row !== null)).toHaveLength(1);
    expect([successorAHash, successorBHash]).toContain(winner.token_hash);
    const losingHash = winner.token_hash === successorAHash ? successorBHash : successorAHash;
    expect(await db.getRefreshTokenByHash(winner.token_hash)).toMatchObject({
      id: winner.id,
      revoked_at: null,
    });
    expect(await db.getRefreshTokenByHash(losingHash)).toBeNull();

    await db.revokeAllRefreshTokensForFamily(user.id, clientId);
    expect(await db.getRefreshTokenByHash(winner.token_hash)).toMatchObject({
      id: winner.id,
      revoked_at: expect.any(Date),
    });
  } finally {
    await db.shutdown();
  }
});

test('leaves no active successor when rotation races family revocation', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new TypeError('DATABASE_URL is required for the PostgreSQL security test');
  }

  await db.init(databaseUrl);
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      // Given: a distinct family with one active token for each race attempt.
      const { clientId, expiresAt, oldToken, runId, user } = await createTokenFamily();
      const successorHash = `e2e-concurrent-successor-${runId}`;

      // When: rotation and replay-triggered family revocation run concurrently.
      const [successor] = await Promise.all([
        db.rotateRefreshToken(oldToken.id, {
          tokenHash: successorHash,
          scope: 'openid',
          expiresAt,
        }),
        db.revokeAllRefreshTokensForFamily(user.id, clientId),
      ]);

      // Then: a successor that was inserted cannot remain active.
      const persisted = await db.getRefreshTokenByHash(successorHash);
      expect(persisted === null || persisted.revoked_at !== null).toBe(true);
      if (successor !== null) {
        expect(persisted).toMatchObject({ id: successor.id, revoked_at: expect.any(Date) });
      }
    }
  } finally {
    await db.shutdown();
  }
});
