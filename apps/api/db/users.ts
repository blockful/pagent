import { client, withRetry } from './connection.ts';

// ---------------------------------------------------------------------------
// Users (Google + Magic Link upsert)
// ---------------------------------------------------------------------------
// `handle` is assigned after collision-checking via getUserByHandle. Magic
// link users are keyed by verified email; Google users are keyed by the
// provider-scoped immutable `google_sub`. Email remains unique profile data.
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

export type GoogleUserUpsertInput = {
  readonly googleSubject: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly handle: string;
};

export type GoogleUserUpsertResult =
  | { readonly kind: 'success'; readonly user: UserRow }
  | { readonly kind: 'link_required' }
  | { readonly kind: 'identity_conflict' };

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
    return c.begin(async (tx): Promise<UserRow> => {
      await tx`
        select pg_advisory_xact_lock(hashtextextended('user-email:' || lower(${input.email}), 0))
      `;
      const rows = await tx<UserRow[]>`
        insert into users (email, name, avatar_url, handle)
        values (${input.email}, ${input.name}, ${input.avatarUrl}, ${input.handle})
        on conflict (lower(email)) do update set
          email = excluded.email,
          name = excluded.name,
          avatar_url = excluded.avatar_url,
          updated_at = now()
        returning id, handle, email, name, avatar_url, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) throw new Error('user upsert returned no row');
      return row;
    });
  });
}

/**
 * Create or refresh a Google-backed user using Google's provider-scoped
 * immutable subject as the identity key. Email-only rows are deliberately
 * not auto-linked: linking requires an authenticated account-settings flow.
 */
export async function upsertGoogleUser(
  input: GoogleUserUpsertInput,
): Promise<GoogleUserUpsertResult> {
  return withRetry(async () => {
    const c = client();
    return c.begin(async (tx): Promise<GoogleUserUpsertResult> => {
      await tx`
        select pg_advisory_xact_lock(
          hashtextextended('google-sub:' || ${input.googleSubject}, 0)
        )
      `;
      await tx`
        select pg_advisory_xact_lock(hashtextextended('user-email:' || lower(${input.email}), 0))
      `;

      const subjectRows = await tx<Pick<UserRow, 'id'>[]>`
        select id from users where google_sub = ${input.googleSubject}
      `;
      const subjectUser = subjectRows[0];
      if (subjectUser) {
        const emailOwners = await tx<Pick<UserRow, 'id'>[]>`
          select id
          from users
          where lower(email) = lower(${input.email})
            and id <> ${subjectUser.id}
        `;
        if (emailOwners[0]) return { kind: 'identity_conflict' };
        const updated = await tx<UserRow[]>`
          update users
          set email = ${input.email},
              name = ${input.name},
              avatar_url = ${input.avatarUrl},
              updated_at = now()
          where id = ${subjectUser.id}
          returning id, handle, email, name, avatar_url, created_at, updated_at
        `;
        const user = updated[0];
        if (!user) throw new Error('Google user update returned no row');
        return { kind: 'success', user };
      }

      const emailRows = await tx<{ google_sub: string | null }[]>`
        select google_sub from users where lower(email) = lower(${input.email})
      `;
      const emailOwner = emailRows[0];
      if (emailOwner) {
        return emailOwner.google_sub === null
          ? { kind: 'link_required' }
          : { kind: 'identity_conflict' };
      }

      const inserted = await tx<UserRow[]>`
        insert into users (google_sub, email, name, avatar_url, handle)
        values (
          ${input.googleSubject}, ${input.email}, ${input.name},
          ${input.avatarUrl}, ${input.handle}
        )
        returning id, handle, email, name, avatar_url, created_at, updated_at
      `;
      const user = inserted[0];
      if (!user) throw new Error('Google user insert returned no row');
      return { kind: 'success', user };
    });
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
