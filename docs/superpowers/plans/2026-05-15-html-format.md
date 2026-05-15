# HTML Page Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTML as a second first-class page format alongside A2UI, with two MCP tools (`show_ui` for asking, `show_html` for showing). HTML pages are view-only, JS-free, sandbox-iframe-rendered. Backwards compatible with all existing A2UI clients.

**Architecture:** Single API endpoint (`POST /new`) accepts an optional `format` field discriminating A2UI vs HTML. New `format` column on the `pages` table. Server-side DOMPurify sanitization on HTML submission. Renderer routes by `format` and renders HTML inside a sandboxed iframe with strict CSP via meta tag. Two MCP tools surface this to the agent.

**Tech Stack:** TypeScript (strict), Hono, Zod, Postgres (via `postgres`), Lit, Vite, Vitest, DOMPurify (via `isomorphic-dompurify`).

**Spec:** [`docs/superpowers/specs/2026-05-15-html-format-design.md`](../specs/2026-05-15-html-format-design.md)

---

## File structure

**New files:**
- `apps/api/sanitize.ts` — DOMPurify wrapper, exports `sanitize(html)`
- `apps/api/sanitize.test.ts` — tests for each blocked tag/attr/URI scheme
- `apps/web/html-renderer.ts` — scaffolded-HTML + iframe rendering helpers (pure functions)
- `apps/web/html-renderer.test.ts` — tests for scaffold + iframe attrs

**Modified files:**
- `apps/api/db.ts` — add `format` to schema, `Page` type, insert/get
- `apps/api/schemas.ts` — discriminated-union `newPageBodySchema`
- `apps/api/schemas.test.ts` — new cases for both branches
- `apps/api/store.ts` — `createPage` accepts `format`
- `apps/api/app.ts` — sanitize on POST /new, surface `format` in GET responses, reject POST result on HTML
- `apps/api/app.test.ts` — new cases for HTML POST /new flow, format echo, result rejection
- `apps/api/db.test.ts` — Page-with-format round-trip
- `apps/api/mcp/tools.ts` — add `show_html`, sharpen `show_ui`, surface `format` in `check_result`
- `apps/api/package.json` — add `isomorphic-dompurify` dep
- `apps/mcp/server.ts` — wire `showHtml` in `PageOps`
- `apps/web/main.ts` — route by `format` in `applySpec` / fetch flow
- `apps/web/csp.ts` — add `buildIframeCsp()`
- `apps/web/csp.test.ts` — tests for `buildIframeCsp`
- `skills/pagent/SKILL.md` — show/ask dichotomy + skill description
- `docs/openapi.yaml` — document `format` field on `POST /new` and `GET` responses

**Three commits, one PR:**
1. API + storage + sanitizer (Tasks 1–6)
2. MCP tools (Tasks 7–9)
3. Renderer + skill + docs (Tasks 10–14)
Plus Task 15 (quality gate) and Task 16 (push + PR).

---

## Task 1: Add `format` column to DB schema and `Page` type

**Files:**
- Modify: `apps/api/db.ts`
- Modify: `apps/api/db.test.ts`

The `format` column lives on every row. Existing rows backfill to `'a2ui'` via the column default. The bootstrap `init()` adds both a create-table-if-not-exists (for fresh deployments) and an idempotent `alter table … add column if not exists` (for existing deployments). Idempotent on every boot.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/db.test.ts` (find the existing `describe('insertPage / getActivePage', …)` block and add a sibling describe or extend it; if no DB tests exist for round-trips, add a new block — preserve any existing setup/teardown):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as db from './db.ts';
import { newId } from './store.ts';

// Reuse whatever DATABASE_URL the suite uses (vitest.config.ts sets it).
describe('Page format column', () => {
  beforeAll(async () => {
    await db.init(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('round-trips format=a2ui (default) and format=html', async () => {
    const idA = newId();
    const idH = newId();
    const now = Date.now();
    await db.insertPage({
      id: idA,
      spec: { a: 1 },
      format: 'a2ui',
      state: 'open',
      result: null,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    await db.insertPage({
      id: idH,
      spec: '<div>hi</div>',
      format: 'html',
      state: 'open',
      result: null,
      createdAt: now,
      expiresAt: now + 60_000,
    });

    const pA = await db.getActivePage(idA);
    const pH = await db.getActivePage(idH);
    expect(pA?.format).toBe('a2ui');
    expect(pH?.format).toBe('html');
    expect(pH?.spec).toBe('<div>hi</div>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run db.test.ts -t "format column"`
Expected: FAIL — `Page` type does not have `format`, `insertPage` doesn't accept it, `getActivePage` returns nothing for format. TypeScript error or runtime null.

- [ ] **Step 3: Update `Page` type and DB layer**

In `apps/api/db.ts`, replace the existing `Page` type with:

```ts
export type PageFormat = 'a2ui' | 'html';

export type Page = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  createdAt: number;
  expiresAt: number;
};
```

Update the bootstrap `init()` (around line 39–57). Replace the create-table block with:

```ts
  await sql`
    create table if not exists pages (
      id           text primary key,
      spec         jsonb       not null,
      format       text        not null default 'a2ui' check (format in ('a2ui','html')),
      state        text        not null check (state in ('open','submitted','received')),
      result       jsonb,
      created_at   timestamptz not null default now(),
      expires_at   timestamptz not null,
      submitted_at timestamptz,
      received_at  timestamptz
    )
  `;
  // Pick up the column on pre-existing deployments. Idempotent.
  await sql`
    alter table pages
      add column if not exists format text
        not null default 'a2ui'
        check (format in ('a2ui','html'))
  `;
  await sql`create index if not exists pages_expires_at_idx on pages (expires_at)`;
```

Update `PageRow` (around line 75):

```ts
type PageRow = {
  id: string;
  spec: unknown;
  format: PageFormat;
  state: PageState;
  result: unknown;
  created_at: Date;
  expires_at: Date;
};
```

Update `getActivePage` (around line 84). Add `format` to the select and the returned object:

```ts
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
```

Update `insertPage` (around line 171):

```ts
export async function insertPage(p: Page): Promise<void> {
  await withRetry(async () => {
    const c = client();
    await c`insert into pages (id, spec, format, state, expires_at)
            values (
              ${p.id},
              ${c.json(p.spec as Parameters<typeof c.json>[0])},
              ${p.format},
              'open',
              to_timestamp(${p.expiresAt} / 1000.0)
            )`;
  });
}
```

Also update `fetchAndAdvanceResult` to read and return `format` so the result handler can echo it:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run db.test.ts -t "format column"`
Expected: PASS — both rows insert and round-trip with their formats preserved.

- [ ] **Step 5: Commit (defer until end of Phase 1)**

Don't commit yet — Phase 1 commits at the end of Task 6 to keep the tree green between API steps that depend on each other.

---

## Task 2: Discriminated-union `newPageBodySchema`

**Files:**
- Modify: `apps/api/schemas.ts`
- Modify: `apps/api/schemas.test.ts`

`newPageBodySchema` becomes a `z.discriminatedUnion` so a single Zod parse yields the typed `{ format, spec }` shape. A2UI is the default; HTML branch enforces `spec` is a non-empty string ≤ 1 MB.

- [ ] **Step 1: Write the failing tests**

In `apps/api/schemas.test.ts`, replace the `describe('newPageBodySchema', …)` block with:

```ts
describe('newPageBodySchema', () => {
  it('rejects {} (no spec key)', () => {
    expect(newPageBodySchema.safeParse({}).success).toBe(false);
  });

  it('defaults format to "a2ui" when absent', () => {
    const r = newPageBodySchema.safeParse({ spec: { foo: 1 } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe('a2ui');
  });

  it('accepts explicit { format: "a2ui", spec: [] }', () => {
    const r = newPageBodySchema.safeParse({ format: 'a2ui', spec: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe('a2ui');
  });

  it('accepts { format: "html", spec: "<div>hi</div>" }', () => {
    const r = newPageBodySchema.safeParse({ format: 'html', spec: '<div>hi</div>' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.format).toBe('html');
      expect(r.data.spec).toBe('<div>hi</div>');
    }
  });

  it('rejects { format: "html", spec: [] } (HTML spec must be string)', () => {
    expect(newPageBodySchema.safeParse({ format: 'html', spec: [] }).success).toBe(false);
  });

  it('rejects { format: "html", spec: "" } (HTML spec must be non-empty)', () => {
    expect(newPageBodySchema.safeParse({ format: 'html', spec: '' }).success).toBe(false);
  });

  it('rejects { format: "html", spec: <1 MB + 1 byte string> }', () => {
    const big = 'a'.repeat(1_000_001);
    expect(newPageBodySchema.safeParse({ format: 'html', spec: big }).success).toBe(false);
  });

  it('rejects { format: "rss", spec: "x" } (unknown format)', () => {
    expect(newPageBodySchema.safeParse({ format: 'rss', spec: 'x' }).success).toBe(false);
  });

  it('still accepts pre-existing payloads with no format field', () => {
    // Backwards compatibility — all existing MCP clients
    expect(newPageBodySchema.safeParse({ spec: null }).success).toBe(true);
    expect(newPageBodySchema.safeParse({ spec: { foo: 1 } }).success).toBe(true);
    expect(newPageBodySchema.safeParse({ spec: 'string' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run schemas.test.ts -t newPageBodySchema`
Expected: FAIL — current schema doesn't have a discriminated union; the format-specific cases fail.

- [ ] **Step 3: Update the schema**

Replace `newPageBodySchema` in `apps/api/schemas.ts` (lines 9–12) with:

```ts
// spec contents are opaque per format:
//   a2ui — unknown JSON (passed through to the renderer; PRD §spec)
//   html — UTF-8 string with a 1 MB cap
// The default for `format` keeps every pre-discriminator client working
// without changes (they POST `{ spec }` and land on the a2ui branch).
export const newPageBodySchema = z.union([
  z.object({
    format: z.literal('a2ui').optional().default('a2ui'),
    spec: z.unknown(),
  }),
  z.object({
    format: z.literal('html'),
    spec: z.string().min(1).max(1_000_000),
  }),
]);

export type NewPageBody = z.infer<typeof newPageBodySchema>;
```

Add an `export type PageFormat = 'a2ui' | 'html';` if not exported from `db.ts` yet (it is from Task 1; just confirm the import surface).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run schemas.test.ts -t newPageBodySchema`
Expected: PASS — all 9 cases green.

- [ ] **Step 5: Defer commit (Phase 1)**

---

## Task 3: Add `apps/api/sanitize.ts`

**Files:**
- Create: `apps/api/sanitize.ts`
- Create: `apps/api/sanitize.test.ts`
- Modify: `apps/api/package.json` (add dep)

The sanitizer runs server-side once on HTML submission, before storage. Uses DOMPurify in jsdom via `isomorphic-dompurify`. Strict denylist: `<script>`, `<iframe>`, `<frame>`, `<frameset>`, `<embed>`, `<object>`, `<applet>`, `<link>`, `<base>`, `<meta>`. All event handlers (`on*=`) stripped. URL scheme allowlist: `https:`, `mailto:`, `#`, `data:image/*`.

- [ ] **Step 1: Add the dependency**

In `apps/api/package.json`, add to `dependencies` (alphabetical order; insert after `hono-rate-limiter`):

```json
    "isomorphic-dompurify": "^2.16.0",
```

Then install:

```bash
cd /Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/.claude/worktrees/keen-roentgen-e25c2a
npm install
```

Expected: `isomorphic-dompurify` and transitive deps (`dompurify`, `jsdom`) added to `node_modules`. No error.

- [ ] **Step 2: Write the failing tests**

Create `apps/api/sanitize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitize } from './sanitize.ts';

describe('sanitize', () => {
  it('returns clean payloads unchanged (idempotent on safe input)', () => {
    const safe = '<div class="card"><h1>Hello</h1><p>World <em>!</em></p></div>';
    expect(sanitize(safe).output).toBe(safe);
  });

  it('preserves inline <style>', () => {
    const input = '<style>.x{color:red}</style><div class="x">hi</div>';
    expect(sanitize(input).output).toContain('<style>');
    expect(sanitize(input).output).toContain('.x{color:red}');
  });

  it('preserves data: image URLs', () => {
    const input = '<img src="data:image/png;base64,iVBORw0K" alt="x">';
    expect(sanitize(input).output).toContain('data:image/png;base64');
  });

  it('preserves https: anchor hrefs', () => {
    const input = '<a href="https://example.com">link</a>';
    expect(sanitize(input).output).toContain('href="https://example.com"');
  });

  it('strips <script>', () => {
    const out = sanitize('<div>safe</div><script>alert(1)</script>').output;
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<div>safe</div>');
  });

  it('strips <iframe>', () => {
    const out = sanitize('<iframe src="https://attacker.example"></iframe>').output;
    expect(out).not.toContain('<iframe');
  });

  it('strips <object>', () => {
    const out = sanitize('<object data="x.swf"></object>').output;
    expect(out).not.toContain('<object');
  });

  it('strips <embed>', () => {
    const out = sanitize('<embed src="x.swf">').output;
    expect(out).not.toContain('<embed');
  });

  it('strips <link>', () => {
    const out = sanitize('<link rel="stylesheet" href="https://attacker.example/x.css">').output;
    expect(out).not.toContain('<link');
  });

  it('strips <base>', () => {
    const out = sanitize('<base href="https://attacker.example/">').output;
    expect(out).not.toContain('<base');
  });

  it('strips <meta http-equiv=refresh>', () => {
    const out = sanitize('<meta http-equiv="refresh" content="0;url=https://attacker.example">').output;
    expect(out).not.toContain('<meta');
  });

  it('strips on* event handlers', () => {
    const out = sanitize('<button onclick="alert(1)">x</button>').output;
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
  });

  it('strips onerror on <img>', () => {
    const out = sanitize('<img src="x" onerror="alert(1)">').output;
    expect(out).not.toContain('onerror');
  });

  it('strips javascript: URLs in href', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>').output;
    expect(out).not.toMatch(/javascript:/i);
  });

  it('strips vbscript: URLs', () => {
    const out = sanitize('<a href="vbscript:msgbox(1)">click</a>').output;
    expect(out).not.toMatch(/vbscript:/i);
  });

  it('strips data:text/html (executable data URL)', () => {
    const out = sanitize('<a href="data:text/html,<script>alert(1)</script>">click</a>').output;
    expect(out).not.toContain('data:text/html');
  });

  it('strips formaction (form override attack)', () => {
    const out = sanitize('<button formaction="https://attacker.example">x</button>').output;
    expect(out).not.toContain('formaction');
  });

  it('strips srcdoc on any element', () => {
    const out = sanitize('<iframe srcdoc="<script>x</script>"></iframe>').output;
    expect(out).not.toContain('srcdoc');
  });

  it('preserves inline <svg>', () => {
    const input = '<svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';
    const out = sanitize(input).output;
    expect(out).toContain('<svg');
    expect(out).toContain('<circle');
  });

  it('strips xlink:href on SVG (legacy XSS vector)', () => {
    const out = sanitize('<svg><use xlink:href="javascript:alert(1)"/></svg>').output;
    expect(out).not.toMatch(/xlink:href/i);
  });

  it('reports counts of removed tags and attrs', () => {
    const r = sanitize('<script>1</script><button onclick="x">y</button>');
    expect(r.removedTags + r.removedAttrs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run sanitize.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the sanitizer**

Create `apps/api/sanitize.ts`:

```ts
/**
 * Server-side HTML sanitization for the html page format.
 *
 * Runs once on POST /new before storage. Returns the cleaned HTML plus
 * dropped-tag and dropped-attr counts (logged as forensic signal).
 *
 * Strict denylist, not allowlist — we accept arbitrary HTML/CSS/SVG and
 * remove the dangerous parts. Combined with the iframe sandbox + meta-CSP
 * in the renderer this is layer one of three (sanitizer → CSP → sandbox).
 */
import DOMPurify from 'isomorphic-dompurify';

const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'embed',
  'object',
  'applet',
  'link', // no external stylesheets
  'base', // we inject our own <base> in the renderer scaffold
  'meta', // no <meta http-equiv=refresh>; renderer injects its own meta-CSP
];

const FORBID_ATTR = [
  'formaction',
  'srcdoc',
  'xlink:href',
];

// Allow https links, mailto, in-page anchors, and inline image data URIs only.
// Explicitly blocks javascript:, vbscript:, data:text/html, data:application/*.
const ALLOWED_URI_REGEXP =
  /^(?:https:|mailto:|#|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i;

export function sanitize(html: string): {
  output: string;
  removedTags: number;
  removedAttrs: number;
} {
  const removed: { tag: 0; attr: 0 } = { tag: 0, attr: 0 } as { tag: 0; attr: 0 };
  // We use removed.* as numbers below; cast to keep the literal-zero type aside.
  const counters = removed as unknown as { tag: number; attr: number };

  const hooked = DOMPurify.addHook;
  // Reset hook registry on every call by addHook'ing inside a fresh sanitize call.
  // (DOMPurify hooks are global per instance — we re-add to keep the count fresh.)
  DOMPurify.removeAllHooks();
  hooked('uponSanitizeElement', (_node, data) => {
    if (data.allowedTags[data.tagName] === false) counters.tag++;
  });
  hooked('uponSanitizeAttribute', (_node, data) => {
    if (!data.allowedAttributes[data.attrName]) counters.attr++;
  });

  const output = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;

  DOMPurify.removeAllHooks();

  return {
    output,
    removedTags: counters.tag,
    removedAttrs: counters.attr,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run sanitize.test.ts`
Expected: PASS — all 21 cases green. If DOMPurify behaves slightly differently from expectations (e.g. inlining unknown attrs as text), adjust the test assertions to match observed safe behavior; do NOT loosen the sanitizer config.

- [ ] **Step 6: Defer commit (Phase 1)**

---

## Task 4: Update `store.createPage` and wire sanitizer into `POST /new`

**Files:**
- Modify: `apps/api/store.ts`
- Modify: `apps/api/app.ts`
- Modify: `apps/api/app.test.ts`

`createPage` accepts `format`. `POST /new` runs the sanitizer for HTML payloads, stores the sanitized output, logs the removed counts, and falls through to the existing flow for A2UI.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/app.test.ts` inside the main `describe`:

```ts
describe('POST /new with format=html', () => {
  it('accepts an HTML payload and returns 201 with { id, url, expires_at }', async () => {
    const res = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'html',
        spec: '<div><h1>Hello</h1><p>World</p></div>',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; url: string; expires_at: number };
    expect(body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(body.url).toContain(body.id);
    expect(typeof body.expires_at).toBe('number');
  });

  it('strips <script> from stored HTML', async () => {
    const res = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'html',
        spec: '<div>safe</div><script>alert(1)</script>',
      }),
    });
    const { id } = (await res.json()) as { id: string };

    const get = await app.request(`/${id}`);
    const page = (await get.json()) as { format: string; spec: unknown };
    expect(page.format).toBe('html');
    expect(typeof page.spec).toBe('string');
    expect(page.spec as string).not.toContain('<script');
    expect(page.spec as string).toContain('<div>safe</div>');
  });

  it('rejects HTML payloads > 1 MB', async () => {
    const big = 'a'.repeat(1_000_001);
    const res = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'html', spec: big }),
    });
    // bodyLimit middleware fires before Zod when body is over the absolute cap.
    expect([400, 413]).toContain(res.status);
  });

  it('accepts A2UI payloads with implicit default format (backwards compat)', async () => {
    const res = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: [{ createSurface: { surfaceId: 'm' } }] }),
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run app.test.ts -t "format=html"`
Expected: FAIL — store.createPage doesn't carry `format`; GET /:id doesn't return `format`; sanitizer not wired.

- [ ] **Step 3: Update `store.ts`**

Replace `createPage` in `apps/api/store.ts` (lines 22–39) with:

```ts
export async function createPage(
  spec: unknown,
  format: 'a2ui' | 'html',
  cfg: CreatePageConfig,
): Promise<ShowUiResult> {
  const now = Date.now();
  const page: Page = {
    id: newId(),
    spec,
    format,
    state: 'open',
    result: null,
    createdAt: now,
    expiresAt: now + cfg.pageTtlMs,
  };
  await db.insertPage(page);
  metrics.pagesCreated.add(1, { format });
  return {
    id: page.id,
    url: `${cfg.publicUrl}/${page.id}`,
    expires_at: page.expiresAt,
  };
}
```

Note: `metrics.pagesCreated.add` gets a `format` label. If `metrics.ts` doesn't carry a labeled counter signature here today, just keep the existing `metrics.pagesCreated.add(1)` call without labels — don't widen the metrics interface in this task.

- [ ] **Step 4: Wire sanitizer + format into `POST /new` handler**

Update `newPageHandler` in `apps/api/app.ts` (lines 200–218):

```ts
import { sanitize } from './sanitize.ts';

// …

const newPageHandler = async (c: Context) => {
  const raw = await c.req.json().catch(() => null);
  const result = newPageBodySchema.safeParse(raw);
  if (!result.success) {
    return c.json(
      {
        error: 'bad_request',
        issues: result.error.issues,
        message: 'Request body did not match the expected schema',
      },
      400,
    );
  }
  const { format, spec } = result.data;

  let storedSpec = spec;
  if (format === 'html') {
    const { output, removedTags, removedAttrs } = sanitize(spec as string);
    getLog(c).info(
      { format, removedTags, removedAttrs },
      'sanitized html submission',
    );
    storedSpec = output;
  }

  const created = await store.createPage(storedSpec, format, {
    publicUrl: PUBLIC_URL,
    pageTtlMs: PAGE_TTL_MS,
  });
  return c.json(created, 201);
};
```

Also bump `MAX_BODY_BYTES` so HTML payloads at the cap are accepted by the body-limit middleware. Replace line 41:

```ts
// 1 MB is the HTML payload cap (per spec); A2UI's effective 256 KB cap is
// enforced post-parse in the handler.
export const MAX_BODY_BYTES = 1_000_000;
```

Add a post-parse A2UI cap check inside `newPageHandler` after the Zod parse and before `storedSpec` assignment:

```ts
  if (format === 'a2ui') {
    // Enforce the historical 256 KB cap on A2UI specs; HTML uses the full 1 MB.
    const serialized = JSON.stringify(spec ?? null);
    if (serialized.length > 256_000) {
      return c.json(
        {
          error: 'payload_too_large',
          format: 'a2ui',
          max_bytes: 256_000,
          message: 'A2UI spec exceeds the 256 KB limit; use format: "html" for larger payloads only when appropriate',
        },
        413,
      );
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run app.test.ts -t "format=html"`
Expected: PASS — three HTML cases plus the backcompat A2UI case all green.

- [ ] **Step 6: Defer commit (Phase 1)**

---

## Task 5: Surface `format` in `GET /:id` and `GET /:id/result`; reject `POST /:id/result` on HTML pages

**Files:**
- Modify: `apps/api/app.ts`
- Modify: `apps/api/app.test.ts`

`GET /:id` now returns `format`; `GET /:id/result` returns `format` so the agent (or the renderer / tools) can detect an HTML page and stop polling. `POST /:id/result` on an HTML page returns `400 invalid_for_format`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/app.test.ts`:

```ts
describe('format echo and HTML result handling', () => {
  it('GET /:id includes format=html for an HTML page', async () => {
    const created = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'html', spec: '<p>x</p>' }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/${id}`);
    const body = (await res.json()) as { format: string };
    expect(body.format).toBe('html');
  });

  it('GET /:id includes format=a2ui for an A2UI page', async () => {
    const created = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: [{ createSurface: { surfaceId: 'm' } }] }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/${id}`);
    const body = (await res.json()) as { format: string };
    expect(body.format).toBe('a2ui');
  });

  it('GET /:id/result includes format', async () => {
    const created = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'html', spec: '<p>x</p>' }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/${id}/result`);
    const body = (await res.json()) as { state: string; format: string; result: unknown };
    expect(body.format).toBe('html');
    expect(body.state).toBe('open');
    expect(body.result).toBe(null);
  });

  it('POST /:id/result rejects HTML pages with 400 invalid_for_format', async () => {
    const created = await app.request('/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'html', spec: '<p>x</p>' }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/${id}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'submitted', surfaceId: 'main' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_for_format');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run app.test.ts -t "format echo"`
Expected: FAIL — handlers don't surface `format`; submit handler doesn't reject HTML.

- [ ] **Step 3: Update `getPageHandler`**

In `apps/api/app.ts`, replace the existing `getPageHandler` body (lines 220–232):

```ts
const getPageHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const p = await db.getActivePage(idResult.data);
  if (!p) return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  return c.json({
    spec: p.spec,
    format: p.format,
    state: p.state,
    result: p.result,
    expires_at: p.expiresAt,
  });
};
```

- [ ] **Step 4: Update `getResultHandler`**

In `apps/api/app.ts`, update `getResultHandler` (around line 267). Since `store.advanceResult` returns `CheckResultOutcome` without `format`, we need to extend that — or fetch format separately. Cleanest: extend `advanceResult` to return `format`. Update `apps/api/store.ts`:

```ts
export async function advanceResult(id: string): Promise<CheckResultOutcome> {
  const r = await db.fetchAndAdvanceResult(id);
  if (!r) return { kind: 'not_found' };
  return { kind: 'state', state: r.stateAtRead, result: r.result, format: r.format };
}
```

Update `CheckResultOutcome` type in `apps/api/mcp/tools.ts`:

```ts
export type CheckResultOutcome =
  | { kind: 'not_found' }
  | { kind: 'state'; state: PageState; result: unknown; format: 'a2ui' | 'html' };
```

Then update `getResultHandler` in `apps/api/app.ts`:

```ts
const getResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  const outcome = await store.advanceResult(idResult.data);
  if (outcome.kind === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  return c.json({ state: outcome.state, result: outcome.result, format: outcome.format });
};
```

- [ ] **Step 5: Update `submitResultHandler` to reject HTML pages**

In `apps/api/app.ts`, update `submitResultHandler` (around line 234). Insert a format check after the page-id parse but before reading the body:

```ts
const submitResultHandler = async (c: Context) => {
  const idResult = pageIdSchema.safeParse(c.req.param('id'));
  if (!idResult.success)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);

  // Format check happens before body parse to fail fast on HTML pages.
  const page = await db.getActivePage(idResult.data);
  if (!page)
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  if (page.format !== 'a2ui') {
    return c.json(
      {
        error: 'invalid_for_format',
        format: page.format,
        message: `POST /:id/result is not supported for format=${page.format}; HTML pages are view-only`,
      },
      400,
    );
  }

  const raw = await c.req.json().catch(() => null);
  const bodyResult = resultBodySchema.safeParse(raw);
  if (!bodyResult.success) {
    return c.json(
      {
        error: 'bad_request',
        issues: bodyResult.error.issues,
        message: 'Request body did not match the expected schema',
      },
      400,
    );
  }
  const action = bodyResult.data;
  const outcome = await db.submitPage(idResult.data, action);
  if (outcome.kind === 'not_found')
    return c.json({ error: 'not_found', message: 'Page not found or expired' }, 404);
  if (outcome.kind === 'conflict')
    return c.json(
      {
        error: 'conflict',
        message: 'Page was already submitted; create a new page if you need another submission',
      },
      409,
    );
  metrics.pagesSubmitted.add(1);
  metrics.pageSubmitLatency.record((Date.now() - outcome.createdAt.getTime()) / 1000);
  return c.json({ ok: true });
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run app.test.ts -t "format echo"`
Expected: PASS — all four cases green.

- [ ] **Step 7: Defer commit (Phase 1)**

---

## Task 6: Phase 1 commit

**Files:** all of Tasks 1–5.

Now that the API + storage + sanitizer all hang together with green tests, commit Phase 1 as one atomic unit.

- [ ] **Step 1: Run the full API test suite**

Run: `cd /Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/.claude/worktrees/keen-roentgen-e25c2a && npx vitest run apps/api`
Expected: All tests pass. No regressions in existing tests.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No TypeScript errors. (If errors mention `Page` type missing `format`, recheck Task 1 Step 3.)

- [ ] **Step 3: Stage and commit**

Run from repo root:

```bash
git add apps/api/db.ts apps/api/db.test.ts \
        apps/api/schemas.ts apps/api/schemas.test.ts \
        apps/api/store.ts \
        apps/api/app.ts apps/api/app.test.ts \
        apps/api/sanitize.ts apps/api/sanitize.test.ts \
        apps/api/package.json apps/api/mcp/tools.ts \
        package-lock.json
git commit -m "$(cat <<'EOF'
feat(api): add HTML page format alongside A2UI

POST /new accepts an optional { format: "a2ui" | "html", spec } body.
Default remains "a2ui" — every existing client keeps working unchanged.
HTML payloads up to 1 MB are sanitized server-side (DOMPurify+jsdom via
isomorphic-dompurify) before storage, then echoed in GET /:id and
GET /:id/result so renderers and tools can route. POST /:id/result on
an HTML page returns 400 invalid_for_format — HTML is view-only.

Schema: new `format` column on `pages`, NOT NULL DEFAULT 'a2ui' with
CHECK ('a2ui','html'). Added in init() with an idempotent ALTER TABLE
for existing deployments.

Three defensive layers for HTML: sanitize -> CSP (renderer) -> iframe
sandbox (renderer). This commit lands the sanitizer; renderer work in
a follow-up commit on the same branch.

Spec: docs/superpowers/specs/2026-05-15-html-format-design.md
EOF
)"
```

- [ ] **Step 4: Verify**

Run: `git log --oneline -1 && git status`
Expected: New commit present. Working tree clean (no untracked or modified files).

---

## Task 7: Add `show_html` MCP tool + sharpen `show_ui` + surface `format` in `check_result`

**Files:**
- Modify: `apps/api/mcp/tools.ts`
- Modify: `apps/mcp/server.ts` (HTTP smoke / typing if needed)

`show_ui` keeps its existing signature, gets a sharper description. New `show_html({ html: string })` tool. `check_result`'s `structuredContent` grows a `format` field.

- [ ] **Step 1: Write the failing tests**

Create or extend `apps/api/mcp/tools.test.ts` (if it exists, append; otherwise create with this header). The pattern: register the tools against a stub `PageOps` and assert the tool registration shapes.

```ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPagentTools, type PageOps } from './tools.ts';

function makeServer(): { server: McpServer; tools: Map<string, { description: string; inputSchema: unknown; handler: (...args: unknown[]) => unknown }> } {
  const tools = new Map<string, { description: string; inputSchema: unknown; handler: (...args: unknown[]) => unknown }>();
  const server = {
    registerTool(name: string, def: { description: string; inputSchema: unknown }, handler: (...args: unknown[]) => unknown) {
      tools.set(name, { ...def, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

const noopOps: PageOps = {
  showUi: async () => ({ id: 'a'.repeat(32), url: 'http://x/a', expires_at: 0 }),
  showHtml: async () => ({ id: 'b'.repeat(32), url: 'http://x/b', expires_at: 0 }),
  checkResult: async () => ({ kind: 'state', state: 'open', result: null, format: 'a2ui' }),
};

describe('registerPagentTools', () => {
  it('registers three tools: show_ui, show_html, check_result', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    expect(tools.has('show_ui')).toBe(true);
    expect(tools.has('show_html')).toBe(true);
    expect(tools.has('check_result')).toBe(true);
  });

  it('show_html description mentions view-only and no scripts', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    const desc = tools.get('show_html')!.description;
    expect(desc).toMatch(/view-only/i);
    expect(desc).toMatch(/script/i);
    expect(desc).toMatch(/JavaScript/i);
  });

  it('show_ui description distinguishes itself from show_html', () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    const desc = tools.get('show_ui')!.description;
    expect(desc).toMatch(/show_html/);
  });

  it('check_result structuredContent includes format', async () => {
    const { server, tools } = makeServer();
    registerPagentTools(server, noopOps);
    const handler = tools.get('check_result')!.handler;
    const out = (await handler({ page_id: 'a'.repeat(32) })) as {
      structuredContent: { state: string; result: unknown; page_id: string; format: string };
    };
    expect(out.structuredContent.format).toBe('a2ui');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run mcp/tools.test.ts`
Expected: FAIL — `showHtml` not on `PageOps`, tool not registered, `format` not in structuredContent.

- [ ] **Step 3: Extend `PageOps` and add `show_html` description**

In `apps/api/mcp/tools.ts`, update the interface:

```ts
export interface PageOps {
  showUi(spec: unknown): Promise<ShowUiResult>;
  showHtml(html: string): Promise<ShowUiResult>;
  checkResult(page_id: string): Promise<CheckResultOutcome>;
}
```

(`CheckResultOutcome` was already extended in Task 5 to include `format`.)

Sharpen `SHOW_UI_DESCRIPTION` and add `SHOW_HTML_DESCRIPTION` and `SHOW_HTML_INPUT_DESCRIPTION`. Replace the descriptions block (lines 38–58) with:

```ts
const SHOW_UI_DESCRIPTION = [
  "Ask the user a question that needs a structured answer back. Forms, pickers, confirmations, multi-step wizards, surveys, dashboards-as-input.",
  "Returns { page_id, url, expires_at }. PRINT the URL so the user can open it. The agent never sees the user typing — only the final submitted result.",
  "Each page is single-shot: one spec, one result. For a follow-up question, call show_ui again with a fresh spec — there is no surface-replace mechanism.",
  "After this call, poll check_result on your own cadence to read the user response (start at 2-3s, back off exponentially up to ~30s; do other useful work between polls rather than blocking).",
  "If you only want to SHOW something — a report, a chart, an infographic — use show_html instead. show_ui is for input.",
].join('\n\n');

const SHOW_UI_INPUT_DESCRIPTION = [
  'A2UI v0.9 spec — an array of A2UI messages.',
  'Start with one createSurface, then updateComponents with a tree whose root component MUST have id "root".',
  'The basic catalog (https://a2ui.org/specification/v0_9/basic_catalog.json) provides Column, Row, Card, Text, TextField, Button, Checkbox, Image, Divider, List, Tabs, Slider.',
  'Buttons fire actions via { action: { event: { name, context } } }; bind input fields with { value: { path: "/key" } } and reference those paths in the button context so user input flows back.',
  'Keep specs small — one screen, one purpose.',
].join(' ');

const SHOW_HTML_DESCRIPTION = [
  "Show the user a rich visualization: a styled report, dashboard, chart, infographic, comparison table, slide, or other view-only artifact.",
  "Returns { page_id, url, expires_at }. PRINT the URL so the user can open it. The page is one-way — the user looks at it; nothing comes back.",
  "Do NOT poll check_result for HTML pages; they never produce a result. If you need a follow-up decision, call show_ui after with a fresh spec.",
  "Constraints (enforced — violations are stripped or rejected): no <script> tags, no on*= event handlers, no javascript: URLs (JavaScript does not run); no external assets — inline all CSS as <style>, embed images as data:image/...;base64,... URIs (no Google Fonts, no CDN libraries, no remote <img src=https:>); no <form> submissions (use show_ui for input); no <iframe>, <meta http-equiv=refresh>; 1 MB payload cap.",
].join('\n\n');

const SHOW_HTML_INPUT_DESCRIPTION = [
  'A single UTF-8 HTML string. May be a fragment or a full document; the renderer wraps it in a sandboxed scaffold either way.',
  'Inline all CSS as <style>; embed all images as data: URIs. No external assets — they will not load.',
  'Up to 1,000,000 bytes (1 MB).',
].join(' ');

const CHECK_RESULT_DESCRIPTION = [
  'Fetch the current state of a page created by show_ui. Fire-and-return — does NOT block or wait.',
  'Returns { state, result, format, page_id } where state is "open" | "submitted" | "received" and format is "a2ui" | "html".',
  'When state is "open", the user has not responded yet — wait a few seconds and call again. When "submitted", result is the user input as an A2UI client-action: { name, surfaceId, sourceComponentId, context, timestamp }. When "received", you already read the result on a prior poll (treat as duplicate).',
  'If format is "html", the page is view-only — stop polling; HTML pages never produce a result.',
  'If the page expired (Page not found), do NOT retry the same page_id — ask the user in chat whether to start over, then call show_ui (or show_html) with a fresh spec.',
].join('\n\n');
```

Add the `show_html` registration. Inside `registerPagentTools`, after the `show_ui` block, before `check_result`:

```ts
  server.registerTool(
    'show_html',
    {
      title: 'Show HTML visualization to the user',
      description: SHOW_HTML_DESCRIPTION,
      inputSchema: {
        html: z
          .string()
          .min(1)
          .max(1_000_000)
          .describe(SHOW_HTML_INPUT_DESCRIPTION),
      },
    },
    async ({ html }) => {
      const created = await ops.showHtml(html);
      return {
        content: [
          {
            type: 'text',
            text: `View ready. Share this URL with the user:\n${created.url}\n\npage_id: ${created.id}\nexpires_at: ${created.expires_at}\n\nView-only — do not poll check_result for this page.`,
          },
        ],
        structuredContent: {
          page_id: created.id,
          url: created.url,
          expires_at: created.expires_at,
        },
      };
    },
  );
```

Finally, update the `check_result` handler's `structuredContent` to include `format`:

```ts
    async ({ page_id }) => {
      const outcome = await ops.checkResult(page_id);
      if (outcome.kind === 'not_found') {
        throw new Error(
          `Page ${page_id} not found (expired or deleted). Don't retry the same page_id — ask the user whether to start over, then call show_ui (or show_html) with a fresh spec.`,
        );
      }
      const text =
        outcome.format === 'html'
          ? `Page ${page_id} is an HTML view (format: html). It does not produce a result — stop polling. If you need a follow-up decision, call show_ui with a fresh spec.`
          : outcome.result == null
            ? `User has not responded yet (state: ${outcome.state}). Call check_result again in a few seconds.`
            : `User submitted: ${JSON.stringify(outcome.result)}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          state: outcome.state,
          result: outcome.result,
          format: outcome.format,
          page_id,
        },
      };
    },
```

- [ ] **Step 4: Update HTTP MCP adapter in `apps/api`**

Find where the in-process HTTP MCP wires `PageOps`. It's likely `apps/api/mcp/http.ts` (based on the comment in tools.ts). Look at the existing `showUi` adapter — wherever it calls `store.createPage`, add a `showHtml` sibling that does the same with sanitization:

```ts
// In whatever file wires PageOps for the HTTP MCP transport:
const httpOps: PageOps = {
  async showUi(spec) {
    return store.createPage(spec, 'a2ui', { publicUrl: PUBLIC_URL, pageTtlMs: PAGE_TTL_MS });
  },
  async showHtml(html) {
    const { output, removedTags, removedAttrs } = sanitize(html);
    // No request context here — log at the module logger level.
    logger.info({ format: 'html', removedTags, removedAttrs }, 'sanitized html submission (http mcp)');
    return store.createPage(output, 'html', { publicUrl: PUBLIC_URL, pageTtlMs: PAGE_TTL_MS });
  },
  async checkResult(page_id) {
    return store.advanceResult(page_id);
  },
};
```

If the HTTP MCP adapter file doesn't exist (the tools just talk to `store` via a different surface), skip this step and re-check after Task 8 — the stdio adapter is the load-bearing one for plugin users.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run mcp/tools.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 6: Defer commit (Phase 2)**

---

## Task 8: Wire `showHtml` into the stdio MCP server

**Files:**
- Modify: `apps/mcp/server.ts`

The stdio adapter (`apps/mcp/server.ts`) calls the REST API. Add the `showHtml` POST that sets `format: 'html'` in the body.

- [ ] **Step 1: Update `PageOps` impl**

In `apps/mcp/server.ts`, replace the `restOps` constant (lines 56–78) with:

```ts
const restOps: PageOps = {
  async showUi(spec) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    if (!res.ok) throw await readError(res, 'show_ui');
    return (await res.json()) as { id: string; url: string; expires_at: number };
  },
  async showHtml(html) {
    const res = await fetch(`${SERVICE_URL}/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'html', spec: html }),
    });
    if (!res.ok) throw await readError(res, 'show_html');
    return (await res.json()) as { id: string; url: string; expires_at: number };
  },
  async checkResult(page_id) {
    const res = await fetch(`${SERVICE_URL}/${page_id}/result`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) throw await readError(res, 'check_result');
    const body = (await res.json()) as {
      state: 'open' | 'submitted' | 'received';
      result: unknown | null;
      format: 'a2ui' | 'html';
    };
    return { kind: 'state', state: body.state, result: body.result, format: body.format };
  },
};
```

- [ ] **Step 2: Rebuild the bundled MCP server**

Run: `npm run build:mcp`
Expected: `apps/mcp/server.bundle.js` regenerated with the new tool. Single esbuild line. Verify the resulting bundle:

```bash
grep -c "show_html" apps/mcp/server.bundle.js
```

Expected: a positive count (the tool name should appear).

- [ ] **Step 3: Smoke the MCP server (if test infra exists)**

Run: `node apps/mcp/smoke.mjs` (whatever the smoke script does).
Expected: connects to a running API and lists/invokes tools without error. If the smoke script doesn't exist or fails for unrelated reasons (no local API running), skip and rely on the unit tests for verification.

- [ ] **Step 4: Defer commit (Phase 2)**

---

## Task 9: Phase 2 commit

**Files:** all of Tasks 7–8.

- [ ] **Step 1: Run typecheck + relevant test suites**

```bash
npm run typecheck
npx vitest run apps/api/mcp
```

Expected: All green. If the stdio server has any test (`apps/mcp/*.test.ts`), include it.

- [ ] **Step 2: Stage and commit**

```bash
git add apps/api/mcp/tools.ts apps/api/mcp/tools.test.ts \
        apps/mcp/server.ts apps/mcp/server.bundle.js
# Also stage the HTTP MCP adapter file if Task 7 Step 4 touched it.
git commit -m "$(cat <<'EOF'
feat(mcp): add show_html tool + sharpen show_ui description

show_html({ html }) creates an HTML page (view-only, sandbox-rendered).
The model gets two clearly distinct tools — show_ui to ask, show_html
to show — instead of a single tool with a format flag. Sharpens
show_ui's description to point at show_html for visualization use cases.

check_result now returns the page's format in structuredContent so an
agent that polls an HTML page (against guidance) at least gets the
explicit "stop polling" signal.

Both the stdio adapter (apps/mcp/server.ts) and the in-process HTTP
MCP share the tool definitions through apps/api/mcp/tools.ts —
description sync is automatic.

Spec: docs/superpowers/specs/2026-05-15-html-format-design.md
EOF
)"
```

- [ ] **Step 3: Verify**

Run: `git log --oneline -2 && git status`
Expected: Both phase commits visible, working tree clean.

---

## Task 10: Add `buildIframeCsp()` to `apps/web/csp.ts`

**Files:**
- Modify: `apps/web/csp.ts`
- Modify: `apps/web/csp.test.ts`

Pure function returning the CSP directive string that goes into the iframe's `<meta http-equiv>`. Unit-testable in isolation.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/csp.test.ts`:

```ts
import { buildIframeCsp } from './csp.ts';

describe('buildIframeCsp', () => {
  const csp = buildIframeCsp();

  it("sets default-src 'none'", () => {
    expect(csp).toMatch(/default-src 'none'/);
  });

  it("allows img-src 'self' data:", () => {
    expect(csp).toMatch(/img-src 'self' data:/);
  });

  it("allows style-src 'unsafe-inline' only (no external)", () => {
    expect(csp).toMatch(/style-src 'unsafe-inline'/);
    expect(csp).not.toMatch(/style-src[^;]*https:/);
  });

  it('allows font-src data: only', () => {
    expect(csp).toMatch(/font-src data:/);
    expect(csp).not.toMatch(/font-src[^;]*https:/);
  });

  it("blocks form submission via form-action 'none'", () => {
    expect(csp).toMatch(/form-action 'none'/);
  });

  it("blocks nested iframes via frame-src 'none'", () => {
    expect(csp).toMatch(/frame-src 'none'/);
  });

  it("blocks base-uri rewriting via base-uri 'none'", () => {
    expect(csp).toMatch(/base-uri 'none'/);
  });

  it('declares sandbox', () => {
    expect(csp).toMatch(/(^|; )sandbox(;|$)/);
  });

  it('does not enable scripts (no script-src directive)', () => {
    // default-src 'none' covers script-src by default; explicit script-src
    // would be a regression — assert absence.
    expect(csp).not.toMatch(/script-src/);
  });

  it('does not include frame-ancestors (handled upstream by shell X-Frame-Options)', () => {
    expect(csp).not.toMatch(/frame-ancestors/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run csp.test.ts -t buildIframeCsp`
Expected: FAIL — function does not exist.

- [ ] **Step 3: Implement**

Append to `apps/web/csp.ts`:

```ts
/**
 * Build the Content-Security-Policy for the *iframe* that wraps agent-submitted
 * HTML. Injected as a <meta http-equiv> inside the srcdoc scaffold (the iframe
 * has an opaque origin under sandbox="" so per-request HTTP headers aren't an
 * option; meta is what the browser will enforce).
 *
 * default-src 'none' starts every fetch class denied. We re-enable only the
 * narrow set HTML pages need to render: inline styles, inline images via
 * data: URIs, inline fonts via data:. No script, no connect, no form, no
 * external anything. Sandbox at the CSP level is redundant with the iframe
 * sandbox attribute but cheap as a second layer.
 *
 * frame-ancestors is deliberately omitted. The opaque-origin iframe makes
 * 'self' meaningless (every opaque origin is unique and can never match the
 * parent). The shell origin sets X-Frame-Options: DENY upstream, which is
 * what would have been protected here.
 */
export function buildIframeCsp(): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    'font-src data:',
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    'sandbox',
  ].join('; ');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run csp.test.ts -t buildIframeCsp`
Expected: PASS — all 10 cases green.

- [ ] **Step 5: Defer commit (Phase 3)**

---

## Task 11: Create the HTML renderer module

**Files:**
- Create: `apps/web/html-renderer.ts`
- Create: `apps/web/html-renderer.test.ts`

Pure scaffold builder + iframe element factory. The renderer in `main.ts` calls into these from a single branch in the format router.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/html-renderer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildScaffoldedHtml, createSandboxedIframe } from './html-renderer.ts';

describe('buildScaffoldedHtml', () => {
  it('wraps the agent body in <!doctype html>', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('includes a charset meta tag', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out).toMatch(/<meta charset="utf-8">/);
  });

  it('includes the iframe CSP meta tag', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out).toMatch(/<meta http-equiv="Content-Security-Policy"/);
    expect(out).toMatch(/default-src 'none'/);
  });

  it('includes robots noindex,nofollow,noarchive', () => {
    const out = buildScaffoldedHtml('<p>x</p>');
    expect(out).toMatch(/<meta name="robots" content="noindex,nofollow,noarchive">/);
  });

  it('injects the agent body inside <body>', () => {
    const out = buildScaffoldedHtml('<p class="x">hello</p>');
    expect(out).toMatch(/<body><p class="x">hello<\/p><\/body>/);
  });

  it('does not interpret the agent body as a template (no double-encoding)', () => {
    const safe = '<div>Hello &amp; goodbye</div>';
    const out = buildScaffoldedHtml(safe);
    expect(out).toContain(safe);
  });
});

describe('createSandboxedIframe', () => {
  it('uses sandbox="" (empty string, no tokens)', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('never includes allow-scripts or allow-same-origin', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    const sandbox = iframe.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('sets referrerpolicy="no-referrer"', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('sets allow="" (empty Permissions-Policy delegation)', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.getAttribute('allow')).toBe('');
  });

  it('sets srcdoc to the scaffolded HTML', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.srcdoc).toContain('<p>x</p>');
    expect(iframe.srcdoc).toContain('default-src');
  });

  it('sets a descriptive title', () => {
    const iframe = createSandboxedIframe('<p>x</p>');
    expect(iframe.title.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Configure the test env to include a DOM**

The renderer tests need DOM globals. Check whether `apps/web/vitest.config.ts` (or a root `vitest.config.ts`) already sets `environment: 'happy-dom'` or `'jsdom'`. If not:

- If a `apps/web/vitest.config.ts` exists, add `test: { environment: 'happy-dom' }` and install `happy-dom`: `npm install -D happy-dom -w @pagent/web` (or `--save-dev` at the root if workspace nesting prefers).
- If no vitest config exists for `apps/web`, add one:

```ts
// apps/web/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
  },
});
```

- Run `npm install` to ensure deps are present.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run html-renderer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the module**

Create `apps/web/html-renderer.ts`:

```ts
/**
 * Renders agent-submitted HTML inside a maximally-locked-down sandboxed iframe.
 *
 * Layer 1 (server, apps/api/sanitize.ts) — DOMPurify strips dangerous tags/attrs
 *   before storage.
 * Layer 2 (this module) — wraps in a scaffold with strict CSP meta + sets
 *   iframe sandbox="" so the iframe document has an opaque origin and no
 *   capabilities. JS does not run.
 * Layer 3 (browser) — same-origin policy enforces opaque-origin isolation
 *   regardless of what the HTML tries to do.
 *
 * The design assumption that JS is OFF is structural — see
 * docs/superpowers/specs/2026-05-15-html-format-design.md § Structural
 * constraint. If anyone adds allow-scripts, the CI tripwire breaks.
 */
import { buildIframeCsp } from './csp.ts';

/**
 * Wrap the (pre-sanitized) agent HTML in a security-headered scaffold.
 * The scaffold is the document the browser parses inside the iframe.
 */
export function buildScaffoldedHtml(sanitizedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${buildIframeCsp()}">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<base target="_blank" rel="noopener noreferrer nofollow ugc">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>${sanitizedHtml}</body>
</html>`;
}

/**
 * Create an iframe element pre-configured with the lockdown attributes.
 * Caller appends to the DOM; this function never touches `document`.
 *
 * CI tripwire: tests assert sandbox="" with no tokens. Removing or
 * weakening this is a security regression per spec.
 */
export function createSandboxedIframe(sanitizedHtml: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  // CRITICAL: empty string — no tokens. allow-scripts / allow-same-origin
  // are forbidden. See spec § Structural constraint.
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', '');
  iframe.setAttribute('loading', 'lazy');
  iframe.title = 'Agent-generated content';
  iframe.srcdoc = buildScaffoldedHtml(sanitizedHtml);
  iframe.style.cssText = 'width:100%;height:100vh;border:0;display:block';
  return iframe;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run html-renderer.test.ts`
Expected: PASS — all 13 cases green.

- [ ] **Step 6: Defer commit (Phase 3)**

---

## Task 12: Update `apps/web/main.ts` to route by format

**Files:**
- Modify: `apps/web/main.ts`

Branch in `loadPage` / `applySpec`. If `format === "html"`, swap the LitElement's body for a chrome bar + the sandboxed iframe; otherwise, do the existing A2UI path.

- [ ] **Step 1: Update the `PageResponse` type**

In `apps/web/main.ts` around line 15, update:

```ts
type PageFormat = 'a2ui' | 'html';
type PageState = 'open' | 'submitted' | 'received';
type PageResponse = {
  spec: unknown;
  format?: PageFormat;     // optional for forward-compat with older API responses
  state: PageState;
  result: unknown | null;
  expires_at: number | string;
};
```

- [ ] **Step 2: Add a format-routed render path**

Add an import at the top of `main.ts`:

```ts
import { createSandboxedIframe } from './html-renderer.js';
```

In the `AgentUIApp` class, add a new state property `format` and an `htmlBody` slot:

```ts
  static properties = {
    status: { state: true },
    error: { state: true },
    submitError: { state: true },
    awaiting: { state: true },
    awaitingMessage: { state: true },
    awaitingStalled: { state: true },
    format: { state: true },
    htmlBody: { state: true },
  };

  // … existing declarations …
  declare format: PageFormat;
  declare htmlBody: string | null;
```

In the constructor, default these:

```ts
    this.format = 'a2ui';
    this.htmlBody = null;
```

Update `loadPage` to pick the right path:

```ts
  private async loadPage() {
    try {
      const res = await fetch(`${API_BASE}/${pageId}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 404) {
        this.status = 'error';
        this.error = 'Page not found or expired.';
        return;
      }
      if (!res.ok) {
        this.status = 'error';
        this.error = `Failed to load page (${res.status}).`;
        return;
      }
      const page = (await res.json()) as PageResponse;
      this.format = page.format ?? 'a2ui';

      if (this.format === 'html') {
        // HTML pages are pre-sanitized server-side. We trust the byte-string
        // and wrap it in a sandboxed iframe. The iframe is opaque-origin and
        // JS-free; nothing it does can reach back into this shell.
        this.htmlBody = typeof page.spec === 'string' ? page.spec : '';
        this.status = 'live';
        return;
      }

      // A2UI path (existing behavior).
      this.applySpec(page.spec);
      this.status = 'live';

      if (page.state === 'submitted') {
        this.awaiting = true;
        this.awaitingMessage = 'Sent — waiting for the agent…';
        this.startPollingForReceived();
      } else if (page.state === 'received') {
        this.awaiting = true;
        this.awaitingMessage = '✓ The agent has your input';
        this.awaitingStalled = false;
      }
    } catch (err) {
      console.error('GET page failed', err);
      this.status = 'error';
      this.error = 'Failed to load page.';
    }
  }
```

Update `render()` to route based on `format`:

```ts
  render() {
    if (this.status === 'error') {
      return html`<div class="error">${this.error ?? 'Connection error'}</div>`;
    }
    if (this.status === 'closed') {
      return html`<div class="status">Session ended.</div>`;
    }

    if (this.format === 'html') {
      return this.renderHtml();
    }

    // Existing A2UI render path:
    const surfaces = Array.from(this.processor.model.surfacesMap.entries());
    if (surfaces.length === 0) {
      return html`<div class="pending">
        <div class="spinner"></div>
        <div class="status">Loading…</div>
      </div>`;
    }
    return html`<section id="surfaces" class="surface-wrap ${this.awaiting ? 'is-awaiting' : ''}">
      ${this.submitError
        ? html`<div class="error" role="alert" aria-live="assertive">${this.submitError}</div>`
        : nothing}
      ${this.awaiting
        ? html`<div
            class="awaiting-banner ${this.awaitingStalled ? 'is-stalled' : ''}"
            role="status"
            aria-live="polite"
          >
            ${this.awaitingStalled
              ? html`<span class="material-symbols" aria-hidden="true">info</span>`
              : html`<div class="small-spinner"></div>`}
            <span>${this.awaitingMessage}</span>
          </div>`
        : nothing}
      <div class="a2ui-host" aria-disabled=${this.awaiting ? 'true' : 'false'}>
        ${repeat(
          surfaces,
          ([id]) => id,
          ([, surface]) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
        )}
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
    </section>`;
  }

  private renderHtml() {
    if (this.htmlBody == null) {
      return html`<div class="pending">
        <div class="spinner"></div>
        <div class="status">Loading…</div>
      </div>`;
    }
    return html`
      <header class="html-chrome" role="contentinfo">
        <span class="html-chrome-label">AI-generated content</span>
        <a
          class="html-chrome-report"
          href=${`mailto:alex@blockful.io?subject=${encodeURIComponent(`Abuse report for page ${pageId}`)}&body=${encodeURIComponent(`Page id: ${pageId}\nDescribe the abuse:\n\n`)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Report
        </a>
      </header>
      ${this.htmlIframe()}
    `;
  }

  // The Lit literal cannot embed a raw iframe element easily because Lit owns
  // attribute setting and srcdoc would be re-escaped. We construct the iframe
  // imperatively and stash it across renders via this helper.
  private cachedIframe: HTMLIFrameElement | null = null;
  private cachedIframeFor: string | null = null;
  private htmlIframe() {
    if (this.htmlBody == null) return nothing;
    if (this.cachedIframe == null || this.cachedIframeFor !== this.htmlBody) {
      this.cachedIframe = createSandboxedIframe(this.htmlBody);
      this.cachedIframeFor = this.htmlBody;
    }
    return this.cachedIframe;
  }
```

Add CSS for the chrome bar to the static `styles`. Insert these rules at the end of the existing `css` block (just before the closing backtick):

```css
    .html-chrome {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: light-dark(rgba(245, 245, 247, 0.95), rgba(20, 24, 32, 0.95));
      backdrop-filter: blur(8px);
      border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
      font-size: 13px;
      color: var(--muted, #777);
    }
    .html-chrome-label::before {
      content: '✦ ';
      opacity: 0.6;
    }
    .html-chrome-report {
      color: inherit;
      text-decoration: underline;
      font-size: 12px;
    }
    .html-chrome-report:hover {
      color: var(--fg, #1b1b1b);
    }
```

- [ ] **Step 3: Run all web tests**

Run: `cd apps/web && npx vitest run`
Expected: PASS — existing tests unchanged (poll-backoff, csp, spec-guard) plus the new csp and html-renderer cases green. If any A2UI flow test fails, recheck the conditional branch in `render()`.

- [ ] **Step 4: Smoke locally**

```bash
cd /Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/.claude/worktrees/keen-roentgen-e25c2a
npm run dev
```

In another terminal:

```bash
# A2UI page — sanity, should keep working
curl -s -X POST http://localhost:8787/new \
  -H 'content-type: application/json' \
  -d '{"spec":[{"createSurface":{"surfaceId":"main","catalogId":"https://a2ui.org/specification/v0_9/basic_catalog.json"}}]}'

# HTML page — new path
curl -s -X POST http://localhost:8787/new \
  -H 'content-type: application/json' \
  -d '{"format":"html","spec":"<style>body{font-family:sans-serif;padding:24px}h1{color:#5154b3}</style><h1>Hello, World</h1><p>This is a Pagent HTML page.</p>"}'
```

Open both returned URLs in the browser. The A2UI URL renders an empty surface; the HTML URL renders the styled `Hello, World` page with the chrome bar above it. Stop `npm run dev` when verified.

- [ ] **Step 5: Defer commit (Phase 3)**

---

## Task 13: Update the skill prose

**Files:**
- Modify: `skills/pagent/SKILL.md`

Top of the file gets a "Picking a tool" section. The description front-matter is broadened to cover both tools.

- [ ] **Step 1: Update the description front-matter**

Replace lines 1–4 (the YAML front matter) with:

```yaml
---
name: pagent
description: Render UI in the user's browser. Two tools — show_ui for asking the user a question that needs a structured answer back (forms, pickers, confirmations, dashboards-as-input, multi-step wizards), and show_html for showing a rich visualization the user just looks at (reports, dashboards, charts, infographics, comparison tables, slides). Trigger on "show me", "ask me", "let me pick", "confirm before you", "give me a dashboard", "render a chart", "show a report" — anything that beats plain text in chat. Rule: if anything has to come back from the user, show_ui. If the user just looks, show_html.
---
```

- [ ] **Step 2: Add the "Picking a tool" section**

Insert a new section after line 4 (right after the front matter, before `# Showing UI to your user`):

```markdown
# Showing UI to your user

## Picking a tool

Two tools, one rule: **`show_html` to show; `show_ui` to ask.**

If anything has to come back from the user — a value, a selection, a click — use `show_ui`. If the user just looks at it — a report, a chart, a dashboard, a comparison — use `show_html`. When in doubt, ask yourself: "Do I need to read the user's response?" Yes → `show_ui`. No → `show_html`.

Multi-step flows work the same way: each step is a separate page. Show a dashboard with `show_html`, then ask "what next?" with `show_ui`. Don't try to bundle visualization and input into one page.

Only A2UI pages (created by `show_ui`) have a result. HTML pages (`show_html`) never transition out of `open` — do not poll `check_result` on them.

## When to use show_ui
```

Then make the existing section header `## When to use this skill` become `## When to use show_ui` to match the new structure. The rest of the file is unchanged.

- [ ] **Step 3: Add a "When to use show_html" section**

After the `## Worked example: "What's your name?"` section (line ~64), insert:

```markdown
## When to use show_html

Reach for `show_html` whenever you want to show the user something rich and visual that text in chat can't do justice to:

- "Show me a styled dashboard of the test results."
- "Render the last quarter's metrics as an infographic."
- "Build me a side-by-side comparison table of these three options, with logos."
- "Give me a one-page report on the open issues, grouped by severity."
- "Mock up a landing page for this idea."
- "Show me a chart of the response times."

Indirect cues: "show me", "render", "make me a", "design a", "lay this out as".

NOT for input: if the next message you'd send the user contains a question they need to answer, use `show_ui` instead.

## How show_html works

Call `show_html(html)` with a single string containing the page body. The string can be a full document (`<!doctype html>…`) or a fragment (`<div>…</div>`) — the renderer wraps it in a sandboxed scaffold either way. The tool returns `{ page_id, url }`. **Print the URL** so the user can open it. Do NOT poll `check_result` on this page — HTML is one-way.

Rules (enforced — violations are stripped or rejected server-side):

- **No JavaScript.** `<script>` tags are stripped. `onclick=`, `onload=`, all `on*=` event handlers are stripped. `javascript:` URLs are stripped.
- **No external assets.** Inline all CSS as `<style>`. Embed images as `data:image/...;base64,...` URIs. No Google Fonts, no CDN scripts, no remote `<img src=https:>`.
- **No forms.** `<form action=…>` submissions are blocked by CSP. Use `show_ui` if you need input.
- **No `<iframe>`, `<meta http-equiv=refresh>`, `<object>`, `<embed>`.** Stripped.
- **1 MB payload cap.** Watch data-URI sizes.

The result: a maximally locked-down sandboxed iframe runs your HTML inside the user's browser. The user views it. Nothing comes back.

## Worked example: a styled report

```python
html = """
<style>
  body { font-family: -apple-system, sans-serif; padding: 32px; max-width: 720px; margin: 0 auto; color: #1b1b1b; }
  h1 { color: #5154b3; }
  .stat { display: inline-block; padding: 16px; margin-right: 12px; background: #f5f5f7; border-radius: 8px; }
  .stat-value { font-size: 32px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #777; text-transform: uppercase; }
</style>
<h1>Q3 Engineering Report</h1>
<div class="stat"><div class="stat-value">142</div><div class="stat-label">PRs merged</div></div>
<div class="stat"><div class="stat-value">11</div><div class="stat-label">Bugs closed</div></div>
<div class="stat"><div class="stat-value">3</div><div class="stat-label">Outages</div></div>
<p>The team shipped 142 pull requests this quarter…</p>
"""
show_html(html)
```

Print the returned URL. Move on — no polling.

# Showing UI to your user (legacy section title — keep the original content below)
```

Note: the diff is fiddly. If the existing structure makes this overly invasive, an acceptable alternative is to replace the entire `skills/pagent/SKILL.md` with a rewritten version that interleaves the two tools cleanly, as long as no examples or polling guidance for `show_ui` is dropped. Validate by running existing skill-related tests if any (`grep -l SKILL.md` against the tests dir).

- [ ] **Step 4: Defer commit (Phase 3)**

---

## Task 14: Update `docs/openapi.yaml`

**Files:**
- Modify: `docs/openapi.yaml`

The OpenAPI spec needs the `format` field on request body and `GET` responses. Loaded at API boot and served at `/openapi.json`.

- [ ] **Step 1: Read the existing spec**

Run: `head -80 docs/openapi.yaml`

Look for `paths: /new: post: requestBody:` and the response schemas for `/new` (201) and `GET /{id}`. Note the structure (likely `application/json` + `schema:` references).

- [ ] **Step 2: Add `format` to relevant schemas**

In `docs/openapi.yaml`:

- Find the `NewPageRequest` (or inline body) schema. Add a `format` property:

```yaml
        format:
          type: string
          enum: [a2ui, html]
          default: a2ui
          description: |
            Spec format. `a2ui` (default) — `spec` is an A2UI v0.9 message array.
            `html` — `spec` is a UTF-8 HTML string up to 1,000,000 bytes; the
            page becomes view-only and never produces a result.
```

- Find the `GET /{id}` response schema (typically `PageResponse`). Add:

```yaml
        format:
          type: string
          enum: [a2ui, html]
          description: Format of the page's spec.
```

- Find the `GET /{id}/result` response. Add the same `format` property.

- Find the `POST /{id}/result` 4xx responses section. Add a 400 response noting `invalid_for_format`:

```yaml
        '400':
          description: |
            Returned when the request body is malformed (bad_request) or when
            the page is not a submit-able format (invalid_for_format —
            HTML pages are view-only).
```

If the OpenAPI file is large enough that hand-edits get error-prone, prefer adding a sibling component schema rather than rewriting in place. Run `npm run typecheck` and `npm run test` to confirm nothing broke from a parsing perspective (the API loads the YAML at boot).

- [ ] **Step 3: Defer commit (Phase 3)**

---

## Task 15: Phase 3 commit + Quality gate

**Files:** Tasks 10–14.

- [ ] **Step 1: Stage and commit Phase 3**

```bash
git add apps/web/csp.ts apps/web/csp.test.ts \
        apps/web/html-renderer.ts apps/web/html-renderer.test.ts \
        apps/web/main.ts \
        skills/pagent/SKILL.md \
        docs/openapi.yaml \
        apps/web/vitest.config.ts apps/web/package.json package-lock.json
# Only stage vitest.config.ts / package.json if Task 11 Step 2 created/modified them.

git commit -m "$(cat <<'EOF'
feat(web): render HTML pages in sandboxed iframe + update skill

The renderer routes by the new `format` field. A2UI pages keep the
existing Lit/A2UI path unchanged. HTML pages render inside an iframe
with sandbox="" (no allow-scripts, no allow-same-origin) and an
opaque origin, with a strict CSP meta tag and noindex/no-referrer
attached to the scaffold. The shell adds a thin chrome bar with an
"AI-generated content" label and a mailto: Report link.

Adds buildIframeCsp() to apps/web/csp.ts and a small html-renderer
module with pure functions (buildScaffoldedHtml, createSandboxedIframe)
so the security-critical paths are unit-tested in isolation.

SKILL.md gets a "show vs ask" section and a worked HTML example; the
front-matter description now covers both tools.

OpenAPI spec documents the new format field on POST /new and the GET
responses.

Spec: docs/superpowers/specs/2026-05-15-html-format-design.md
EOF
)"
```

- [ ] **Step 2: Run the full quality gate**

```bash
cd /Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/.claude/worktrees/keen-roentgen-e25c2a
npm run typecheck
npm run lint
npm run format:check
npm run test
```

Expected: all four green. If `format:check` fails, run `npm run format` to fix automatically and re-stage in a follow-up commit. If lint fails, inspect — most likely fixable with `npm run lint:fix`.

- [ ] **Step 3: Verify the pre-push hook passes**

Run: `.husky/pre-push`
Expected: same suite as Step 2, green.

- [ ] **Step 4: Sanity-check the diff summary**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
```

Expected: three feature commits (API, MCP, renderer+skill) plus the initial docs spec commit. Diff stat shows the right files in the right apps.

---

## Task 16: Push branch and open PR

**Files:** none (git only).

- [ ] **Step 1: Push the branch**

```bash
cd /Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/.claude/worktrees/keen-roentgen-e25c2a
git push -u origin HEAD
```

Expected: branch published to origin. If the remote rejects with "updates were rejected because the tip of your current branch is behind", the worktree branch tracks origin/main behind real main — investigate before forcing.

- [ ] **Step 2: Open the PR via `gh`**

```bash
gh pr create --title "feat: HTML page format for view-only visualizations" --body "$(cat <<'EOF'
## Summary

Adds **HTML** as a second first-class page format alongside A2UI. The agent gets two single-purpose tools:

- `show_ui` (existing) — ask the user a question; A2UI form/picker/confirmation; structured result via `check_result` polling.
- `show_html` (new) — show a rich visualization (report, dashboard, chart, infographic, comparison table). View-only; nothing comes back.

Rule for the agent: **`show_html` to show, `show_ui` to ask.**

## What's in scope

- New `format` field on `POST /new` (`"a2ui"` default — every existing client keeps working unchanged).
- Server-side DOMPurify sanitization (via `isomorphic-dompurify`) on HTML submission.
- 1 MB body cap for HTML; A2UI stays at 256 KB (enforced post-parse).
- New `format` column on `pages` (added in `init()` with idempotent `ALTER TABLE`).
- Renderer routes by format; HTML renders in a sandbox-`""` iframe with strict meta-CSP, no-referrer, noindex.
- Thin shell chrome ("AI-generated content" label + `mailto:` Report link).
- Two MCP tools (`show_ui`, `show_html`); `check_result` now returns `format`.
- SKILL.md teaches the dichotomy.

## What's deliberately out

- JavaScript execution in HTML pages. **Load-bearing constraint** — see `docs/superpowers/specs/2026-05-15-html-format-design.md` § Structural constraint. JS support would require subdomain isolation; we are not making that investment.
- Submit-from-HTML (HTML is view-only; use A2UI for input).
- Subdomain isolation (deferred indefinitely; tied to the JS decision above).
- External assets in HTML (inline only).
- Real abuse-reporting flow beyond `mailto:`.

## Three layers of defense for HTML

1. **Sanitizer (server)** — DOMPurify + jsdom strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<base>`, `<meta>`, all `on*=` handlers, `formaction`, `srcdoc`, `xlink:href`, and dangerous URL schemes.
2. **CSP (renderer)** — `default-src 'none'` + narrow re-enables (`img-src 'self' data:`, `style-src 'unsafe-inline'`, `font-src data:`), `form-action 'none'`, `frame-src 'none'`, `base-uri 'none'`, `sandbox`.
3. **Iframe sandbox (renderer)** — `sandbox=""` with no tokens → opaque origin, no scripts, no forms, no top-nav, no popups, no plugins.

A CI test asserts the iframe sandbox stays empty (no `allow-scripts` ever).

## Test plan

- [ ] `npm run typecheck` green
- [ ] `npm run lint` green
- [ ] `npm run format:check` green
- [ ] `npm run test` green (all existing + ~50 new cases across sanitize/schemas/app/tools/csp/html-renderer)
- [ ] Local smoke (`npm run dev` then `curl` from README's smoke section) — A2UI page renders
- [ ] Local smoke — HTML page renders with chrome bar, no scripts execute, no external network requests
- [ ] CI green on the PR

## Refs

- Spec: `docs/superpowers/specs/2026-05-15-html-format-design.md`
- Plan: `docs/superpowers/plans/2026-05-15-html-format.md`
EOF
)"
```

Expected: PR URL printed. Save it.

- [ ] **Step 3: Report back**

Print the PR URL to the user. Note that merging to `main` will trigger Railway + Vercel auto-deploys (per the existing CD), and remind them that the renderer must reach Vercel before the API reaches Railway — but since both ship from the same `main` push and CD picks each up independently, in practice Vercel finishes first (smaller bundle). Worst case: a few seconds of API-returns-format-html-but-old-renderer-misroutes; the old renderer will treat the HTML page as A2UI and render an error message, which auto-clears on next refresh.

---

## Self-review

**Spec coverage:**

- § Goal & non-goals → Tasks 1–14 cover the in-scope items; out-of-scope explicitly absent (no subdomain isolation, no JS, no submit-from-HTML).
- § Structural constraint → Task 11 sanity check (`createSandboxedIframe` test asserts `sandbox=""` and rejects `allow-scripts` / `allow-same-origin`).
- § Wire format → Tasks 1 (column), 2 (Zod), 5 (response surfaces).
- § API changes → Tasks 4, 5.
- § Sanitizer → Task 3 (module + 21 unit tests covering each forbidden tag/attr/URI).
- § Renderer flow → Tasks 11, 12.
- § Iframe CSP → Task 10.
- § MCP server changes → Tasks 7, 8.
- § Skill prose → Task 13.
- § State machine → Task 5 (POST result rejection; GET result echoes format).
- § Body size, TTL, rate limiting → Task 4 (1 MB bodyLimit + post-parse A2UI cap).
- § Observability → Task 4 wires `sanitized html submission` log line.
- § Testing → Each task has explicit failing-test → impl → passing-test → defer-commit cycle; full quality gate in Task 15.
- § Migration → Task 1 (additive `init()` + idempotent ALTER TABLE).
- § Rollout → Tasks 6, 9, 15 (three commits, one PR); Task 16 docs the deploy ordering caveat in the PR body.

**Placeholder scan:** No "TBD" or "TODO" remains. Two soft-asks remain: Task 7 Step 4 (HTTP MCP adapter location is "check `apps/api/mcp/http.ts`-like") and Task 14 (OpenAPI edits are described rather than reproduced as exact patches). Both are pragmatic because:
- The HTTP MCP adapter file path can vary; an executor with the repo open can find it in <30 seconds.
- The OpenAPI YAML is too large and structured for inline reproduction; the additive-edits guidance is concrete enough.

**Type consistency:** `Page` type carries `format: PageFormat` consistently across Tasks 1, 4, 5. `CheckResultOutcome` extension (Task 5) feeds into Task 7's MCP changes without drift. `PageOps.showHtml` introduced in Task 7 is implemented in Task 8.

**Scope check:** Single PR. Roughly 15–20 files touched, evenly split across the three commits. No subsystem decomposition needed — this is one coherent feature.
