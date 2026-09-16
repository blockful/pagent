import { client, withRetry } from './connection.ts';

// ---------------------------------------------------------------------------
// Users (Google + Magic Link upsert)
// ---------------------------------------------------------------------------
// Backs the Google OAuth callback's user upsert. `handle` is assigned by the
// callback after collision-checking via getUserByHandle. Email is the natural
// key — Google guarantees uniqueness within their tenant, and the
// `users_email_idx` unique index defends against case-variant duplicates.
// See spec §2 (Schema) and §3.7 (Google callback flow).

export type UserRow = {
  id: string;
  handle: string | null;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
};

export type UserUpsertInput = {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  handle: string;
};

/**
 * Insert-or-update a user by email. On first sight, the row is created with
 * the supplied handle. On subsequent logins, name/avatar_url/updated_at are
 * refreshed but `handle` is preserved (it's the user-visible identifier and
 * shouldn't churn just because Google reissued a different display name).
 *
 * Returns the canonical row — caller can rely on `id` being the durable user
 * UUID regardless of whether the row is brand new.
 */
export async function upsertUser(input: UserUpsertInput): Promise<UserRow> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<UserRow[]>`
      insert into users (email, name, avatar_url, handle)
      values (${input.email}, ${input.name}, ${input.avatarUrl}, ${input.handle})
      on conflict (email) do update set
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        updated_at = now()
      returning id, handle, email, name, avatar_url, created_at, updated_at
    `;
    return rows[0]!;
  });
}

/**
 * Lookup a user by handle. Used during handle generation to detect collisions
 * before we attempt the upsert. Case-insensitive via the lower(handle) unique
 * index, so we match the same comparison the DB constraint enforces.
 */
export async function getUserByHandle(handle: string): Promise<UserRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<UserRow[]>`
      select id, handle, email, name, avatar_url, created_at, updated_at
      from users
      where lower(handle) = lower(${handle})
    `;
    return rows[0] ?? null;
  });
}

/**
 * Lookup a user by primary key. Used by the token endpoint to populate JWT
 * claims (email/handle) when exchanging an auth code or refresh token. Cascade
 * delete keeps auth_codes / refresh_tokens in sync with users, so a missing
 * row here means the user was deleted between issuing and exchanging — which
 * the caller surfaces as `invalid_grant`.
 */
export async function getUserById(id: string): Promise<UserRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<UserRow[]>`
      select id, handle, email, name, avatar_url, created_at, updated_at
      from users
      where id = ${id}
    `;
    return rows[0] ?? null;
  });
}
