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
  returnTo?: string;
  browserTransactionHash?: string;
  consentGranted?: boolean;
};

export type MagicLinkInsert = {
  email: string;
  tokenHash: string;
  authorizeContext: MagicLinkAuthorizeContext;
  expiresAt: Date;
};

export type MagicLinkRow = {
  email: string;
  authorizeContext: MagicLinkAuthorizeContext;
};

function mapMagicLinkRow(row: {
  email: string;
  authorize_context: MagicLinkAuthorizeContext | null;
}): MagicLinkRow {
  return {
    email: row.email,
    authorizeContext: row.authorize_context ?? {},
  };
}

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
 * Read an active magic link without consuming it. The route uses this only to
 * validate browser-transaction, consent, client, redirect, and PKCE bindings
 * before the one-time token is burned. The later UPDATE remains the atomic
 * single-use gate, so concurrent valid callbacks still have at most one
 * winner.
 */
export async function getActiveMagicLink(tokenHash: string): Promise<MagicLinkRow | null> {
  const c = client();
  const rows = await c<{ email: string; authorize_context: MagicLinkAuthorizeContext | null }[]>`
    select email, authorize_context
    from magic_links
    where token_hash = ${tokenHash}
      and expires_at > now()
      and consumed_at is null
  `;
  const row = rows[0];
  return row === undefined ? null : mapMagicLinkRow(row);
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
export async function verifyAndConsumeMagicLink(tokenHash: string): Promise<MagicLinkRow | null> {
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
  return mapMagicLinkRow(rows[0]!);
}
