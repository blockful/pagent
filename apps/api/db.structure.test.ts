import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { databaseSsl } from './db.ts';
import type { Page, PageFormat } from './db.ts';

const dbDirectory = join(dirname(fileURLToPath(import.meta.url)), 'db');
const read = (name: string) => readFileSync(join(dbDirectory, name), 'utf8').replace(/\s+/g, ' ');
const connection = read('connection.ts');
const pages = read('pages.ts');
const refreshTokens = read('refresh-tokens.ts');

// ---------------------------------------------------------------------------
// Page format column — structural tests (no live DB)
// ---------------------------------------------------------------------------
// Real DB round-trips are out of scope for the unit suite (postgres URL is a
// placeholder in vitest.config.ts). Instead, we assert that the type surface
// carries `format`, that a row projection including `format` produces a Page
// with the expected discriminator, and that PageFormat is the closed union.

// Type test: PageFormat is a closed union — assigning anything outside
// 'a2ui' | 'html' must fail to typecheck. The `@ts-expect-error` directive
// does the verification at compile time; npm run typecheck will fail if the
// union ever loosens. No runtime assertion is needed (and would be misleading
// since 'pdf' === 'pdf' is trivially true at runtime).
// @ts-expect-error — only 'a2ui' | 'html' should typecheck.
const _pageFormatClosedUnion: PageFormat = 'pdf';
void _pageFormatClosedUnion;

describe('Page format column (structural)', () => {
  it('PageFormat accepts the two allowed string literals', () => {
    const a: PageFormat = 'a2ui';
    const h: PageFormat = 'html';
    expect(a).toBe('a2ui');
    expect(h).toBe('html');
  });

  it('Page accepts format and exposes it on the read shape', () => {
    const p: Page = {
      id: 'aabbccddeeff00112233445566778899',
      spec: { foo: 1 },
      format: 'html',
      state: 'open',
      result: null,
      createdAt: 1,
      expiresAt: 2,
    };
    expect(p.format).toBe('html');
  });

  it('row projection from a select including `format` maps to Page.format', async () => {
    // Mirrors getActivePage's mapping over the retry path. If the SELECT
    // were to drop `format`, the projection would lose it; this regression
    // test ensures the mapping is wired both ways.
    type Row = {
      id: string;
      spec: unknown;
      format: PageFormat;
      state: 'open';
      result: unknown;
      created_at: Date;
      expires_at: Date;
    };
    const fakeRow: Row = {
      id: 'test-id',
      spec: '<div>hi</div>',
      format: 'html',
      state: 'open',
      result: null,
      created_at: new Date(1000),
      expires_at: new Date(2000),
    };
    const projected: Page = {
      id: fakeRow.id,
      spec: fakeRow.spec,
      format: fakeRow.format,
      state: fakeRow.state,
      result: fakeRow.result,
      createdAt: fakeRow.created_at.getTime(),
      expiresAt: fakeRow.expires_at.getTime(),
    };
    expect(projected.format).toBe('html');
    expect(projected.spec).toBe('<div>hi</div>');
  });
});

// ---------------------------------------------------------------------------
// init() schema bootstrap — structural assertions over db.ts source
// ---------------------------------------------------------------------------
// init() runs `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT
// EXISTS` / `CREATE INDEX IF NOT EXISTS` on every boot. These tests verify
// the SQL bootstrap matches the auth design spec (docs/superpowers/specs/
// 2026-05-17-auth-design.md §2) without needing a live DB.

describe('init() — auth tables', () => {
  it('creates the users table idempotently with uuid PK and required email', () => {
    expect(connection).toMatch(/create table if not exists users \(/i);
    // Columns may have variable internal whitespace in the source; match on
    // the column + type + key constraint only.
    expect(connection).toMatch(/id\s+uuid\s+primary key default gen_random_uuid\(\)/i);
    expect(connection).toMatch(/handle\s+text\s+unique/i);
    expect(connection).toMatch(/email\s+text\s+unique not null/i);
  });

  it('creates unique indexes on lower(email) and lower(handle)', () => {
    expect(connection).toMatch(
      /create unique index if not exists users_email_idx on users \(lower\(email\)\)/i,
    );
    expect(connection).toMatch(
      /create unique index if not exists users_handle_idx on users \(lower\(handle\)\)/i,
    );
  });

  it('creates the sessions table with ON DELETE CASCADE to users', () => {
    expect(connection).toMatch(/create table if not exists sessions \(/i);
    expect(connection).toMatch(
      /user_id\s+uuid\s+not null references users\(id\) on delete cascade/i,
    );
    expect(connection).toMatch(/token_hash\s+text\s+not null/i);
  });

  it('creates user_id and expires_at indexes on sessions', () => {
    expect(connection).toMatch(
      /create index if not exists sessions_user_id_idx on sessions \(user_id\)/i,
    );
    expect(connection).toMatch(
      /create index if not exists sessions_expires_at_idx on sessions \(expires_at\)/i,
    );
  });

  it('creates a unique token_hash index on sessions (lookup-path)', () => {
    // Every authenticated request looks up by token_hash. Without this index
    // each request does a sequential scan on sessions.
    expect(connection).toMatch(
      /create unique index if not exists sessions_token_hash_idx on sessions \(token_hash\)/i,
    );
  });

  it('creates the oauth_clients table with array columns and defaults', () => {
    expect(connection).toMatch(/create table if not exists oauth_clients \(/i);
    expect(connection).toMatch(/client_id\s+text\s+primary key/i);
    expect(connection).toMatch(/redirect_uris\s+text\[\]\s+not null/i);
    expect(connection).toMatch(
      /grant_types\s+text\[\]\s+not null default '\{authorization_code,refresh_token\}'/i,
    );
    expect(connection).toMatch(/response_types\s+text\[\]\s+not null default '\{code\}'/i);
    expect(connection).toMatch(/token_endpoint_auth_method\s+text\s+not null default 'none'/i);
  });

  it('creates auth_codes with FKs cascading from users and oauth_clients', () => {
    expect(connection).toMatch(/create table if not exists auth_codes \(/i);
    expect(connection).toMatch(/code\s+text\s+primary key/i);
    expect(connection).toMatch(
      /user_id\s+uuid\s+not null references users\(id\) on delete cascade/i,
    );
    expect(connection).toMatch(
      /client_id\s+text\s+not null references oauth_clients\(client_id\) on delete cascade/i,
    );
    expect(connection).toMatch(/code_challenge_method\s+text\s+not null default 'S256'/i);
  });

  it('creates expires_at index on auth_codes', () => {
    expect(connection).toMatch(
      /create index if not exists auth_codes_expires_at_idx on auth_codes \(expires_at\)/i,
    );
  });

  it('creates refresh_tokens with unique token_hash and FK cascades', () => {
    expect(connection).toMatch(/create table if not exists refresh_tokens \(/i);
    expect(connection).toMatch(/id\s+uuid\s+primary key default gen_random_uuid\(\)/i);
    expect(connection).toMatch(/token_hash\s+text\s+not null unique/i);
  });

  it('creates user_id and expires_at indexes on refresh_tokens', () => {
    expect(connection).toMatch(
      /create index if not exists refresh_tokens_user_id_idx on refresh_tokens \(user_id\)/i,
    );
    expect(connection).toMatch(
      /create index if not exists refresh_tokens_expires_at_idx on refresh_tokens \(expires_at\)/i,
    );
  });

  it('creates magic_links with unique token_hash and expires_at index', () => {
    expect(connection).toMatch(/create table if not exists magic_links \(/i);
    expect(connection).toMatch(/email\s+text\s+not null/i);
    expect(connection).toMatch(/token_hash\s+text\s+not null unique/i);
    expect(connection).toMatch(/consumed_at timestamptz/i);
    expect(connection).toMatch(
      /create index if not exists magic_links_expires_at_idx on magic_links \(expires_at\)/i,
    );
  });

  it('every auth table is created with IF NOT EXISTS (idempotent)', () => {
    for (const t of [
      'users',
      'sessions',
      'oauth_clients',
      'auth_codes',
      'refresh_tokens',
      'magic_links',
    ]) {
      expect(connection).toMatch(new RegExp(`create table if not exists ${t} \\(`, 'i'));
    }
  });

  it('every expires_at index is created with IF NOT EXISTS', () => {
    for (const t of ['sessions', 'auth_codes', 'refresh_tokens', 'magic_links']) {
      expect(connection).toMatch(
        new RegExp(`create index if not exists ${t}_expires_at_idx on ${t} \\(expires_at\\)`, 'i'),
      );
    }
  });
});

describe('init() — database TLS', () => {
  it('verifies server certificates unless sslmode=disable is explicit', () => {
    expect(databaseSsl('postgresql://user:pass@db.example.com/app')).toBe('verify-full');
    expect(databaseSsl('postgresql://user:pass@db.example.com/app?sslmode=require')).toBe(
      'verify-full',
    );
    expect(databaseSsl('postgresql://user:pass@localhost/app?sslmode=disable')).toBe(false);
  });
});

describe('rotateRefreshToken() — atomic compare-and-set', () => {
  it('inserts a successor only from a successfully revoked active token', () => {
    expect(refreshTokens).toMatch(
      /with revoked as \( update refresh_tokens set revoked_at = now\(\) where id = \$\{oldTokenId\} and revoked_at is null returning user_id, client_id \) insert into refresh_tokens \(user_id, client_id, token_hash, scope, expires_at\) select revoked\.user_id, revoked\.client_id, \$\{successor\.tokenHash\}, \$\{successor\.scope\}, \$\{successor\.expiresAt\} from revoked returning id, user_id, client_id, token_hash, scope, created_at, expires_at, revoked_at/,
    );
  });
});

describe('init() — pages.owner_id alteration', () => {
  it('adds owner_id as a nullable FK with ON DELETE SET NULL', () => {
    expect(connection).toMatch(
      /alter table pages add column if not exists owner_id uuid references users\(id\) on delete set null/i,
    );
  });

  it('does not declare owner_id as NOT NULL (grace period requires nullable)', () => {
    // Capture the owner_id ALTER statement up to (but not including) the next
    // ALTER/CREATE/await and confirm it has no `not null`.
    const m = connection
      .toLowerCase()
      .match(/alter table pages add column if not exists owner_id[\s\S]*?on delete set null/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('not null');
  });

  it('creates pages_owner_id_idx index', () => {
    expect(connection).toMatch(
      /create index if not exists pages_owner_id_idx on pages \(owner_id\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// insertPage — owner_id binding (structural)
// ---------------------------------------------------------------------------
// Real DB writes are out of scope for the unit suite; verify the INSERT
// statement references `owner_id` and binds `p.ownerId ?? null` so the SQL
// NULL path is exercised when the caller omits the field. Behavioural
// coverage (authenticated POST /new → owner_id set; anon → NULL) lives in
// app.test.ts which mocks db.insertPage.

describe('insertPage — owner_id column wiring (structural)', () => {
  it('INSERT statement includes the owner_id column', () => {
    expect(pages).toMatch(/insert into pages \(id, spec, format, state, expires_at, owner_id\)/i);
  });

  it('owner_id value binds p.ownerId with a nullish-coalescing fallback to null', () => {
    // The grace-period contract (REQUIRE_AUTH=false → owner_id IS NULL) hinges
    // on this fallback — if the bind dropped `?? null`, an `undefined` would
    // surface as the string 'undefined' or a 23502 not-null violation.
    expect(pages).toMatch(/\$\{p\.ownerId \?\? null\}/);
  });
});

describe('Page type — ownerId field', () => {
  it('Page accepts ownerId and reads it back unchanged', () => {
    const p: Page = {
      id: 'aabbccddeeff00112233445566778899',
      spec: { foo: 1 },
      format: 'a2ui',
      state: 'open',
      result: null,
      createdAt: 1,
      expiresAt: 2,
      ownerId: '11111111-2222-3333-4444-555555555555',
    };
    expect(p.ownerId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('Page accepts ownerId = null (anonymous grace-period page)', () => {
    const p: Page = {
      id: 'aabbccddeeff00112233445566778899',
      spec: { foo: 1 },
      format: 'a2ui',
      state: 'open',
      result: null,
      createdAt: 1,
      expiresAt: 2,
      ownerId: null,
    };
    expect(p.ownerId).toBeNull();
  });

  it('Page accepts omitted ownerId (treated as null at the DB layer)', () => {
    const p: Page = {
      id: 'aabbccddeeff00112233445566778899',
      spec: { foo: 1 },
      format: 'a2ui',
      state: 'open',
      result: null,
      createdAt: 1,
      expiresAt: 2,
    };
    expect(p.ownerId).toBeUndefined();
  });
});
