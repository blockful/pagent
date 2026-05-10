import postgres from 'postgres';

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
  const c = client();
  const rows = await c<PageRow[]>`
    select id, spec, state, result, created_at, expires_at
    from pages
    where id = ${id} and expires_at > now()
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    spec: r.spec,
    state: r.state,
    result: r.result,
    createdAt: r.created_at.getTime(),
    expiresAt: r.expires_at.getTime(),
  };
}

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
  const c = client();
  await c`
    insert into pages (id, spec, state, expires_at)
    values (
      ${p.id},
      ${c.json(p.spec as never)},
      'open',
      to_timestamp(${p.expiresAt} / 1000.0)
    )
  `;
}

export async function deletePage(id: string): Promise<void> {
  const c = client();
  await c`delete from pages where id = ${id}`;
}

export async function deleteExpiredPages(): Promise<number> {
  const c = client();
  const result = await c`delete from pages where expires_at <= now()`;
  return result.count;
}
