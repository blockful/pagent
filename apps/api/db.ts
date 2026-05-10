import postgres from 'postgres';

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
};

/** Retry a transient async operation with exponential backoff + ±25% jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 100;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = baseDelay * 2 ** i * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export type PageState = 'open' | 'submitted' | 'received';

export type Page = {
  id: string;
  spec: unknown;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
};

let sql: ReturnType<typeof postgres> | null = null;

export async function init(connectionString: string): Promise<void> {
  if (sql) return;
  const sslMode = new URL(connectionString).searchParams.get('sslmode');
  const ssl = sslMode === 'disable' ? false : 'require';
  sql = postgres(connectionString, { ssl, prepare: false });
  await sql`
    create table if not exists pages (
      id           text primary key,
      spec         jsonb       not null,
      state        text        not null check (state in ('open','submitted','received')),
      result       jsonb,
      created_at   timestamptz not null default now(),
      expires_at   timestamptz not null,
      submitted_at timestamptz,
      received_at  timestamptz
    )
  `;
  await sql`create index if not exists pages_expires_at_idx on pages (expires_at)`;
}

export async function ping(): Promise<void> {
  const c = client();
  await c`select 1`;
}

export async function shutdown(): Promise<void> {
  if (!sql) return;
  await sql.end({ timeout: 5 });
  sql = null;
}

function client(): ReturnType<typeof postgres> {
  if (!sql) throw new Error('db not initialized');
  return sql;
}

type PageRow = {
  id: string;
  spec: unknown;
  state: PageState;
  result: unknown;
  created_at: Date;
  expires_at: Date;
};

export async function getActivePage(id: string): Promise<Page | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<PageRow[]>`
      select id, spec, state, result, created_at, expires_at
      from pages
      where id = ${id} and expires_at > now()
    `;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      spec: r.spec,
      state: r.state,
      result: r.result,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
    };
  });
}

/**
 * Atomic open→submitted transition. Returns 'ok', 'conflict', or 'not_found'.
 *
 * NOT wrapped in withRetry: if attempt 1 commits but its response is lost on
 * the network, attempt 2 finds state='submitted' and (incorrectly) reports
 * 'conflict' — caller would conclude someone else submitted. Better to
 * surface the network error to the caller, who can decide.
 */
export async function submitPage(
  id: string,
  action: unknown,
): Promise<'ok' | 'conflict' | 'not_found'> {
  const c = client();
  const rows = await c<{ id: string }[]>`
    update pages
    set state = 'submitted',
        result = ${c.json(action as never)},
        submitted_at = now()
    where id = ${id} and state = 'open' and expires_at > now()
    returning id
  `;
  if (rows.length > 0) return 'ok';
  // Disambiguate: does the page exist at all (conflict) or not (not_found)?
  const exists = await c<{ id: string }[]>`select id from pages where id = ${id}`;
  return exists.length > 0 ? 'conflict' : 'not_found';
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
): Promise<{ stateAtRead: PageState; result: unknown } | null> {
  const c = client();
  const rows = await c<{ state: PageState; result: unknown }[]>`
    select state, result from pages where id = ${id} and expires_at > now()
  `;
  if (rows.length === 0) return null;
  const { state, result } = rows[0];
  const stateAtRead = state;
  if (state === 'submitted') {
    await c`
      update pages
      set state = 'received', received_at = now()
      where id = ${id} and state = 'submitted'
    `;
  }
  return { stateAtRead, result };
}

export async function insertPage(p: Page): Promise<void> {
  await withRetry(async () => {
    const c = client();
    await c`insert into pages (id, spec, state, expires_at)
            values (${p.id}, ${c.json(p.spec as never)}, 'open', to_timestamp(${p.expiresAt} / 1000.0))`;
  });
}

export async function deletePage(id: string): Promise<void> {
  await withRetry(async () => {
    const c = client();
    await c`delete from pages where id = ${id}`;
  });
}

export async function deleteExpiredPages(): Promise<number> {
  return withRetry(async () => {
    const c = client();
    const result = await c`delete from pages where expires_at <= now()`;
    return result.count;
  });
}
