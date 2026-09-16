import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  const statements: Array<{ text: string; values: readonly unknown[] }> = [];
  const execute = vi.fn(
    async (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): Promise<readonly unknown[]> => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      statements.push({ text, values });
      if (text.startsWith('select user_id, client_id')) {
        return [{ user_id: 'user-1', client_id: 'client-1' }];
      }
      if (text.startsWith('with revoked as')) {
        return [
          {
            id: 'successor-1',
            user_id: 'user-1',
            client_id: 'client-1',
            token_hash: 'new-hash',
            scope: 'openid',
            created_at: new Date('2026-01-01T00:00:00Z'),
            expires_at: new Date('2026-02-01T00:00:00Z'),
            revoked_at: null,
          },
        ];
      }
      return [];
    },
  );
  const begin = vi.fn(
    async (callback: (transactionSql: typeof execute) => Promise<unknown>): Promise<unknown> =>
      callback(execute),
  );
  return { begin, execute, sql: Object.assign(execute, { begin }), statements };
});

vi.mock('./connection.ts', () => ({
  client: () => database.sql,
}));

import { revokeAllRefreshTokensForFamily, rotateRefreshToken } from './refresh-tokens.ts';

beforeEach(() => {
  database.begin.mockClear();
  database.execute.mockClear();
  database.statements.length = 0;
});

describe('refresh-token family serialization', () => {
  it('locks the family before rotating a token', async () => {
    await rotateRefreshToken('old-token', {
      tokenHash: 'new-hash',
      scope: 'openid',
      expiresAt: new Date('2026-02-01T00:00:00Z'),
    });

    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(database.statements.map(({ text }) => text)).toEqual([
      expect.stringMatching(/^select user_id, client_id/),
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringMatching(/^with revoked as/),
    ]);
    expect(database.statements.at(1)?.values).toEqual(['user-1', 'client-1']);
  });

  it('locks the family in a prior statement before taking the revocation snapshot', async () => {
    await revokeAllRefreshTokensForFamily('user-1', 'client-1');

    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(database.statements.map(({ text }) => text)).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringMatching(/^update refresh_tokens/),
    ]);
    expect(database.statements.at(0)?.values).toEqual(['user-1', 'client-1']);
  });
});
