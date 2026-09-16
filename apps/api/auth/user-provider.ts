import * as db from '../db.ts';

// Handles are user-visible (URL slugs, display) so they share the
// constraints we'd apply to any short identifier: lowercase alphanumeric +
// dashes, 3-40 chars, must start/end with alphanumeric. The spec's regex is
// applied on read elsewhere; here we only need to produce a value that
// matches.
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const HANDLE_ALLOCATION_ATTEMPTS = 10;

function isHandleConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint_name' in error &&
    (error.constraint_name === 'users_handle_key' || error.constraint_name === 'users_handle_idx')
  );
}

/**
 * Reduce the email local part to handle-shaped characters.
 *
 * Steps:
 *   1. lowercase
 *   2. strip everything that isn't alphanumeric or dash
 *   3. trim leading/trailing dashes (HANDLE_REGEX requires alphanumeric anchors)
 *   4. enforce length: pad with "user" if too short, truncate if too long
 *
 * Returns a string that's guaranteed to satisfy HANDLE_REGEX. Callers then
 * resolve collisions via generateUniqueHandle.
 */
export function sanitizeHandle(local: string): string {
  let h = local.toLowerCase().replace(/[^a-z0-9-]/g, '');
  // Strip leading/trailing dashes — HANDLE_REGEX requires the first and
  // last char to be alphanumeric.
  h = h.replace(/^-+/, '').replace(/-+$/, '');
  // Pad short locals with "user" so we always end up >= 3 chars. A 0-length
  // input (e.g. all special chars stripped) yields "user".
  if (h.length < 3) h = (h + 'user').slice(0, 40);
  // Truncate long locals.
  if (h.length > 40) h = h.slice(0, 40);
  // Re-trim in case truncation re-exposed a trailing dash.
  h = h.replace(/^-+/, '').replace(/-+$/, '');
  // Final sanity check — if any of the above produced an invalid value
  // (e.g. all dashes input), fall back to a stable default. Vanishingly
  // rare in practice but keeps the contract iron-clad.
  if (!HANDLE_REGEX.test(h)) {
    h = 'user';
  }
  return h;
}

/**
 * Pick a handle that isn't already taken by another user.
 *
 * Tries the sanitized base, then `${base}2`, `${base}3`, etc., shortening
 * the base if needed to fit the suffix within the 40-char cap. Bails after
 * 999 attempts — at that point we'd rather fail loudly than spin.
 */
export async function generateUniqueHandle(local: string): Promise<string> {
  const base = sanitizeHandle(local);
  if (!(await db.getUserByHandle(base))) return base;
  for (let suffix = 2; suffix <= 999; suffix++) {
    const suffixStr = String(suffix);
    // Slice the base so base+suffix fits in 40 chars. For short bases this
    // is a no-op; for max-length bases we lose a few chars off the end.
    const trimmed = base.slice(0, 40 - suffixStr.length).replace(/-+$/, '');
    const candidate = `${trimmed}${suffixStr}`;
    if (HANDLE_REGEX.test(candidate) && !(await db.getUserByHandle(candidate))) {
      return candidate;
    }
  }
  throw new Error('handle generation exhausted');
}

/**
 * Profile fields extracted from Google's ID token (or a Magic Link).
 * `avatarUrl` may be null for Magic Link users (no profile picture).
 */
export interface UserProfile {
  email: string;
  name?: string;
  avatarUrl?: string;
}

export type GoogleUserProfile = {
  readonly googleSubject: string;
  readonly email: string;
  readonly name?: string;
  readonly avatarUrl?: string;
};

/**
 * Insert-or-update a user by email. On a brand-new email the row is created
 * with a freshly generated handle; on a returning email name/avatar_url are
 * refreshed but the handle is left alone (it's the user-visible identifier
 * and shouldn't churn).
 *
 * Returns the resulting user row so the callback can reference its `id` /
 * `handle` when issuing the authorization code.
 */
export async function upsertUser(profile: UserProfile): Promise<db.UserRow> {
  const email = profile.email.trim().toLowerCase();
  // Local part of the email is the seed for the handle. RFC 5321 caps local
  // parts at 64 chars, sanitizeHandle further truncates to 40 — so even
  // pathologically long inputs are bounded.
  const localPart = email.split('@')[0] ?? '';
  for (let attempt = 0; attempt < HANDLE_ALLOCATION_ATTEMPTS; attempt++) {
    const handle = await generateUniqueHandle(localPart);
    try {
      return await db.upsertUser({
        email,
        name: profile.name ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        handle,
      });
    } catch (error) {
      if (!isHandleConflict(error) || attempt === HANDLE_ALLOCATION_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error('handle allocation exhausted');
}

export async function upsertGoogleUser(
  profile: GoogleUserProfile,
): Promise<db.GoogleUserUpsertResult> {
  const email = profile.email.trim().toLowerCase();
  const localPart = email.split('@')[0] ?? '';
  for (let attempt = 0; attempt < HANDLE_ALLOCATION_ATTEMPTS; attempt++) {
    const handle = await generateUniqueHandle(localPart);
    try {
      return await db.upsertGoogleUser({
        googleSubject: profile.googleSubject,
        email,
        name: profile.name ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        handle,
      });
    } catch (error) {
      if (!isHandleConflict(error) || attempt === HANDLE_ALLOCATION_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error('handle allocation exhausted');
}
