export { databaseSsl, init, ping, shutdown, withRetry } from './db/connection.ts';
export type { RetryOptions } from './db/connection.ts';

export {
  deleteExpiredPages,
  deletePage,
  fetchAndAdvanceResult,
  getActivePage,
  insertPage,
  submitPage,
} from './db/pages.ts';
export type { Page, PageFormat, PageState, SubmitOutcome } from './db/pages.ts';

export { getOAuthClientById, insertOAuthClient } from './db/oauth-clients.ts';
export type { OAuthClientInsert, OAuthClientRow } from './db/oauth-clients.ts';

export { getUserByHandle, getUserById, upsertUser } from './db/users.ts';
export type { UserRow, UserUpsertInput } from './db/users.ts';

export { consumeAuthCode, getAuthCodeForReplay, insertAuthCode } from './db/auth-codes.ts';
export type { AuthCodeInsert, AuthCodeRow } from './db/auth-codes.ts';

export {
  getRefreshTokenByHash,
  insertRefreshToken,
  revokeAllRefreshTokensForFamily,
  revokeRefreshToken,
  rotateRefreshToken,
} from './db/refresh-tokens.ts';
export type {
  RefreshTokenInsert,
  RefreshTokenRow,
  RefreshTokenSuccessor,
} from './db/refresh-tokens.ts';

export {
  getActiveMagicLink,
  insertMagicLink,
  verifyAndConsumeMagicLink,
} from './db/magic-links.ts';
export type { MagicLinkAuthorizeContext, MagicLinkInsert, MagicLinkRow } from './db/magic-links.ts';

export {
  deleteSessionByTokenHash,
  extendSessionExpiry,
  getSessionWithUserByTokenHash,
  insertSession,
} from './db/sessions.ts';
export type { SessionInsert, SessionWithUserRow } from './db/sessions.ts';
