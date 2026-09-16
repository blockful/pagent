import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  const statements: string[] = [];
  const execute = vi.fn(async (strings: TemplateStringsArray): Promise<readonly unknown[]> => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push(text);
    if (text.startsWith('delete from sessions')) return [{ id: 'session-1' }];
    if (text.startsWith('delete from auth_codes')) return [{ code: 'code-1' }, { code: 'code-2' }];
    if (text.startsWith('delete from magic_links')) return [];
    if (text.startsWith('delete from refresh_tokens')) return [{ id: 'refresh-1' }];
    return [];
  });
  const begin = vi.fn(
    async (callback: (transactionSql: typeof execute) => Promise<unknown>): Promise<unknown> =>
      callback(execute),
  );
  return { begin, sql: Object.assign(execute, { begin }), statements };
});

vi.mock('./connection.ts', () => ({ client: () => database.sql }));

import { deleteExpiredAuthArtifacts } from './auth-cleanup.ts';

beforeEach(() => {
  database.begin.mockClear();
  database.statements.length = 0;
});

describe('expired auth cleanup', () => {
  it('deletes every TTL-bound auth artifact in one transaction', async () => {
    await expect(deleteExpiredAuthArtifacts()).resolves.toEqual({
      sessions: 1,
      authCodes: 2,
      magicLinks: 0,
      refreshTokens: 1,
      total: 4,
    });
    expect(database.begin).toHaveBeenCalledTimes(1);
    expect(database.statements).toEqual([
      expect.stringMatching(/^delete from sessions/),
      expect.stringMatching(/^delete from auth_codes/),
      expect.stringMatching(/^delete from magic_links/),
      expect.stringMatching(/^delete from refresh_tokens/),
    ]);
  });
});
