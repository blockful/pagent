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
  sql = postgres(connectionString, { ssl: 'require', prepare: false });
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

export async function loadActivePages(into: Map<string, Page>): Promise<void> {
  const c = client();
  const rows = await c<PageRow[]>`
    select id, spec, state, result, created_at, expires_at
    from pages
    where expires_at > now()
  `;
  for (const r of rows) {
    into.set(r.id, {
      id: r.id,
      spec: r.spec,
      state: r.state,
      result: r.result,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
    });
  }
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

export async function markSubmitted(id: string, result: unknown): Promise<void> {
  const c = client();
  await c`
    update pages
    set state = 'submitted',
        result = ${c.json(result as never)},
        submitted_at = now()
    where id = ${id} and state = 'open'
  `;
}

export async function markReceived(id: string): Promise<void> {
  const c = client();
  await c`
    update pages
    set state = 'received',
        received_at = now()
    where id = ${id} and state = 'submitted'
  `;
}

export async function deletePage(id: string): Promise<void> {
  const c = client();
  await c`delete from pages where id = ${id}`;
}
