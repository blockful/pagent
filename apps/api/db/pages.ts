import { client, withRetry } from './connection.ts';

export type PageState = 'open' | 'submitted' | 'received';

export type PageFormat = 'a2ui' | 'html';

export type Page = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
  /**
   * Authenticated user that created this page. Optional / nullable to keep
   * unauthenticated grace-period creation working — when REQUIRE_AUTH=true
   * the POST /new middleware enforces a non-null user. `ON DELETE SET NULL`
   * keeps pages live when the owning user is deleted.
   */
  ownerId?: string | null;
};

type PageRow = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  created_at: Date;
  expires_at: Date;
};

export async function getActivePage(id: string): Promise<Page | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<PageRow[]>`
      select id, spec, format, state, result, created_at, expires_at
      from pages
      where id = ${id} and expires_at > now()
    `;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      spec: r.spec,
      format: r.format,
      state: r.state,
      result: r.result,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
    };
  });
}

export type SubmitOutcome =
  | { kind: 'ok'; createdAt: Date }
  | { kind: 'conflict' }
  | { kind: 'not_found' };

/**
 * Atomic open→submitted transition. Returns the row's `created_at` on success
 * so the caller can record submit-latency without a follow-up query.
 *
 * 'not_found' covers both "no such page id" and "page expired" — the caller
 * doesn't need to distinguish, and the disambiguation SELECT explicitly
 * excludes expired rows so a stale-but-not-yet-swept row reads correctly.
 *
 * NOT wrapped in withRetry: if attempt 1 commits but its response is lost on
 * the network, attempt 2 finds state='submitted' and (incorrectly) reports
 * 'conflict' — caller would conclude someone else submitted. Better to
 * surface the network error to the caller, who can decide.
 */
export async function submitPage(id: string, action: unknown): Promise<SubmitOutcome> {
  const c = client();
  const rows = await c<{ created_at: Date }[]>`
    update pages
    set state = 'submitted',
        result = ${c.json(action as Parameters<typeof c.json>[0])},
        submitted_at = now()
    where id = ${id} and state = 'open' and expires_at > now()
    returning created_at
  `;
  if (rows.length > 0) return { kind: 'ok', createdAt: rows[0]!.created_at };
  // Disambiguate: does the page exist and is it still valid (conflict) or not (not_found)?
  // Filter on expires_at > now() so an expired-but-not-yet-swept row is
  // correctly classified as 'not_found' rather than 'conflict'.
  const exists = await c<{ id: string }[]>`
    select id from pages where id = ${id} and expires_at > now()
  `;
  return exists.length > 0 ? { kind: 'conflict' } : { kind: 'not_found' };
}

/**
 * Read the result and atomically flip submitted→received on the first read.
 *
 * NOT wrapped in withRetry: if attempt 1's UPDATE commits but the response
 * drops, attempt 2 sees state='received' and the caller (the agent) treats
 * the result as "already handled" — they'd discard it. Better to surface
 * the error to the agent's polling loop, which retries at the HTTP level.
 */
export async function fetchAndAdvanceResult(
  id: string,
): Promise<{ stateAtRead: PageState; result: unknown; format: PageFormat } | null> {
  const c = client();
  const rows = await c<{ state: PageState; result: unknown; format: PageFormat }[]>`
    select state, result, format from pages where id = ${id} and expires_at > now()
  `;
  if (rows.length === 0) return null;
  const { state, result, format } = rows[0];
  const stateAtRead = state;
  if (state === 'submitted') {
    await c`
      update pages
      set state = 'received', received_at = now()
      where id = ${id} and state = 'submitted'
    `;
  }
  return { stateAtRead, result, format };
}

export async function insertPage(p: Page): Promise<void> {
  await withRetry(async () => {
    const c = client();
    // owner_id is nullable — postgres-js binds `null` as SQL NULL, which is
    // what the grace-period path (unauthenticated POST /new) requires. When
    // REQUIRE_AUTH=true the route middleware guarantees ownerId is set.
    await c`insert into pages (id, spec, format, state, expires_at, owner_id)
            values (
              ${p.id},
              ${c.json(p.spec as Parameters<typeof c.json>[0])},
              ${p.format},
              'open',
              to_timestamp(${p.expiresAt} / 1000.0),
              ${p.ownerId ?? null}
            )`;
  });
}

export async function deletePage(id: string): Promise<void> {
  await withRetry(async () => {
    const c = client();
    await c`delete from pages where id = ${id}`;
  });
}

/**
 * Deletes expired rows and reports how many were "abandoned" — i.e. still in
 * state='open' when TTL killed them. Pages that already reached
 * 'submitted' or 'received' before expiry don't count as abandoned; they're
 * just garbage collection.
 */
export async function deleteExpiredPages(): Promise<{ total: number; abandoned: number }> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<{ state: PageState }[]>`
      delete from pages where expires_at <= now() returning state
    `;
    const abandoned = rows.filter((r) => r.state === 'open').length;
    return { total: rows.length, abandoned };
  });
}
