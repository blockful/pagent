import { client } from './connection.ts';

// ---------------------------------------------------------------------------
// Magic Links (passwordless email tokens, 15-minute TTL)
// ---------------------------------------------------------------------------
// `token_hash` is SHA-256(raw token) — the raw token is only ever seen by the
// user (in the email) and by the verify handler (in the query string). The
// authorize_context column carries the OAuth round-trip parameters keyed on
// the link so we can resume the flow without inflating the email URL.

/**
 * Authorize-request context stored alongside a magic link so the verify
 * handler can resume the OAuth flow. Mirrors `StateClaims` from state-jwt.ts
 * but without the JWT envelope — we already have a per-token row, so signing
 * would just add overhead.
 *
 * Every field is optional because a future "log in without an OAuth client"
 * path (e.g. browser session) doesn't need the PKCE bits.
 */
export type MagicLinkAuthorizeContext = {
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  state?: string;
  browserSession?: boolean;
  browserTransactionHash?: string;
  consentGranted?: boolean;
};

export type MagicLinkInsert = {
  email: string;
  tokenHash: string;
  authorizeContext: MagicLinkAuthorizeContext;
  expiresAt: Date;
};

/**
 * Insert a fresh magic link row. The raw token is never stored — only the
 * SHA-256 hash from the caller. Not wrapped in withRetry: a retry after a
 * successful insert would surface a unique-violation on token_hash and
 * confuse the caller (the token is already valid).
 */
export async function insertMagicLink(input: MagicLinkInsert): Promise<void> {
  const c = client();
  await c`
    insert into magic_links (email, token_hash, authorize_context, expires_at)
    values (
      ${input.email},
      ${input.tokenHash},
      ${c.json(input.authorizeContext as Parameters<typeof c.json>[0])},
      ${input.expiresAt}
    )
  `;
}

/**
 * Atomically consume a magic link: marks `consumed_at = now()` and returns
 * the email + stored authorize context, but only if the row exists, hasn't
 * expired, and hasn't already been consumed. Concurrent verifies race on the
 * UPDATE WHERE clause — at most one succeeds.
 *
 * Returns null when the token is unknown / expired / already used. The
 * caller surfaces that as a generic "expired or invalid" error — we don't
 * distinguish to avoid leaking whether the token existed at all.
 */
export async function verifyAndConsumeMagicLink(
  tokenHash: string,
): Promise<{ email: string; authorizeContext: MagicLinkAuthorizeContext } | null> {
  const c = client();
  const rows = await c<{ email: string; authorize_context: MagicLinkAuthorizeContext | null }[]>`
    update magic_links
    set consumed_at = now()
    where token_hash = ${tokenHash}
      and expires_at > now()
      and consumed_at is null
    returning email, authorize_context
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    email: r.email,
    // authorize_context is JSONB; postgres-js returns parsed objects already.
    // Treat NULL as an empty context — a legacy row missing the column would
    // still be consumable (e.g. browser-session flow with no PKCE bits).
    authorizeContext: r.authorize_context ?? {},
  };
}
