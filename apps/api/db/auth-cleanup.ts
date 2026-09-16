import { client } from './connection.ts';

export type ExpiredAuthCleanup = {
  sessions: number;
  authCodes: number;
  magicLinks: number;
  refreshTokens: number;
  total: number;
};

export async function deleteExpiredAuthArtifacts(): Promise<ExpiredAuthCleanup> {
  const c = client();
  return c.begin(async (tx) => {
    const sessions = await tx<{ id: string }[]>`
      delete from sessions where expires_at <= now() returning id
    `;
    const authCodes = await tx<{ code: string }[]>`
      delete from auth_codes where expires_at <= now() returning code
    `;
    const magicLinks = await tx<{ id: string }[]>`
      delete from magic_links where expires_at <= now() returning id
    `;
    const refreshTokens = await tx<{ id: string }[]>`
      delete from refresh_tokens where expires_at <= now() returning id
    `;
    return {
      sessions: sessions.length,
      authCodes: authCodes.length,
      magicLinks: magicLinks.length,
      refreshTokens: refreshTokens.length,
      total: sessions.length + authCodes.length + magicLinks.length + refreshTokens.length,
    };
  });
}
