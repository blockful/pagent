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

test('reports the expression-index name for case-insensitive handle conflicts', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const handle = `idx-${runId.slice(0, 12)}`;
    await db.upsertUser({
      email: `handle-index-a-${runId}@example.test`,
      name: null,
      avatarUrl: null,
      handle,
    });

    const conflictingInsert = db.upsertUser({
      email: `handle-index-b-${runId}@example.test`,
      name: null,
      avatarUrl: null,
      handle: handle.toUpperCase(),
    });

    await expect(conflictingInsert).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'users_handle_idx',
    });
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

test('binds Google login to subject across a verified email change', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const googleSubject = `google-sub-${runId}`;
    const created = await db.upsertGoogleUser({
      googleSubject,
      email: `google-old-${runId}@example.test`,
      name: 'Before rename',
      avatarUrl: null,
      handle: `google-${runId}`,
    });
    const updated = await db.upsertGoogleUser({
      googleSubject,
      email: `google-new-${runId}@example.test`,
      name: 'After rename',
      avatarUrl: null,
      handle: `ignored-${runId}`,
    });

    expect(created.kind).toBe('success');
    expect(updated.kind).toBe('success');
    if (created.kind !== 'success' || updated.kind !== 'success') {
      throw new TypeError('Google subject upsert unexpectedly conflicted');
    }
    expect(updated.user.id).toBe(created.user.id);
    expect(updated.user.handle).toBe(created.user.handle);
    expect(updated.user.email).toBe(`google-new-${runId}@example.test`);
  } finally {
    await db.shutdown();
  }
});

test('refuses to auto-link a Google subject to an existing email-only account', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const email = `legacy-${runId}@example.test`;
    const legacy = await db.upsertUser({
      email,
      name: 'Legacy magic-link user',
      avatarUrl: null,
      handle: `legacy-${runId}`,
    });

    const result = await db.upsertGoogleUser({
      googleSubject: `google-sub-${runId}`,
      email,
      name: 'Google profile',
      avatarUrl: null,
      handle: `replacement-${runId}`,
    });

    expect(result).toEqual({ kind: 'link_required' });
    await expect(db.getUserById(legacy.id)).resolves.toMatchObject({
      id: legacy.id,
      name: 'Legacy magic-link user',
    });
  } finally {
    await db.shutdown();
  }
});

test('allows exactly one Google subject to claim a new email under a race', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const email = `google-race-${runId}@example.test`;
    const results = await Promise.all([
      db.upsertGoogleUser({
        googleSubject: `google-sub-a-${runId}`,
        email,
        name: 'Subject A',
        avatarUrl: null,
        handle: `google-a-${runId}`,
      }),
      db.upsertGoogleUser({
        googleSubject: `google-sub-b-${runId}`,
        email,
        name: 'Subject B',
        avatarUrl: null,
        handle: `google-b-${runId}`,
      }),
    ]);

    expect(results.filter((result) => result.kind === 'success')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'identity_conflict')).toHaveLength(1);
  } finally {
    await db.shutdown();
  }
});

test('inspects magic-link bindings without consuming the one-time token', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    const tokenHash = `magic-link-${runId}`;
    const authorizeContext = {
      browserSession: true,
      browserTransactionHash: `browser-${runId}`,
    };
    await db.insertMagicLink({
      email: `magic-link-${runId}@example.test`,
      tokenHash,
      authorizeContext,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(db.getActiveMagicLink(tokenHash)).resolves.toMatchObject({
      authorizeContext,
    });
    await expect(db.getActiveMagicLink(tokenHash)).resolves.toMatchObject({
      authorizeContext,
    });

    const results = await Promise.all([
      db.verifyAndConsumeMagicLink(tokenHash),
      db.verifyAndConsumeMagicLink(tokenHash),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    await expect(db.getActiveMagicLink(tokenHash)).resolves.toBeNull();
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
    familyId: randomUUID(),
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
    const { expiresAt, oldToken, runId } = await createTokenFamily();
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

    await db.revokeAllRefreshTokensForFamily(winner.family_id);
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
      const { expiresAt, oldToken, runId } = await createTokenFamily();
      const successorHash = `e2e-concurrent-successor-${runId}`;

      // When: rotation and replay-triggered family revocation run concurrently.
      const [successor] = await Promise.all([
        db.rotateRefreshToken(oldToken.id, {
          tokenHash: successorHash,
          scope: 'openid',
          expiresAt,
        }),
        db.revokeAllRefreshTokensForFamily(oldToken.family_id),
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
