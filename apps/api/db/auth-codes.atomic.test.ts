import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  const statements: Array<{ text: string; values: readonly unknown[] }> = [];
  let consumeSucceeds = true;
  const execute = vi.fn(
    async (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): Promise<readonly unknown[]> => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      statements.push({ text, values });
      if (text.startsWith('update auth_codes') && consumeSucceeds) {
        return [
          {
            user_id: 'user-1',
            client_id: 'client-1',
            redirect_uri: 'https://client.example/callback',
            code_challenge: 'challenge',
            code_challenge_method: 'S256',
            scope: 'page:create',
            resource: null,
            refresh_token_family_id: 'grant-family-1',
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
  return {
    begin,
    execute,
    setConsumeSucceeds(value: boolean) {
      consumeSucceeds = value;
    },
    sql: Object.assign(execute, { begin }),
    statements,
  };
});

vi.mock('./connection.ts', () => ({
  client: () => database.sql,
}));

import { consumeAuthCodeAndInsertRefreshToken } from './auth-codes.ts';

const refreshToken = {
  userId: 'user-1',
  clientId: 'client-1',
  familyId: 'grant-family-1',
  tokenHash: 'refresh-hash',
  scope: 'page:create',
  expiresAt: new Date('2026-02-01T00:00:00Z'),
};

beforeEach(() => {
  database.begin.mockClear();
  database.execute.mockClear();
  database.statements.length = 0;
  database.setConsumeSucceeds(true);
});

describe('authorization-code issuance serialization', () => {
  it('locks the family before consuming the code and inserting its refresh token', async () => {
    await expect(
      consumeAuthCodeAndInsertRefreshToken('auth-code', refreshToken),
    ).resolves.toMatchObject({
      userId: 'user-1',
      clientId: 'client-1',
      refreshTokenFamilyId: 'grant-family-1',
    });

    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(database.statements.map(({ text }) => text)).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringMatching(/^update auth_codes/),
      expect.stringMatching(/^insert into refresh_tokens/),
    ]);
    expect(database.statements.at(0)?.values).toEqual(['grant-family-1']);
  });

  it('does not insert a refresh token when another exchange consumed the code', async () => {
    database.setConsumeSucceeds(false);

    await expect(
      consumeAuthCodeAndInsertRefreshToken('auth-code', refreshToken),
    ).resolves.toBeNull();
    expect(database.statements.map(({ text }) => text)).toEqual([
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringMatching(/^update auth_codes/),
    ]);
  });
});
