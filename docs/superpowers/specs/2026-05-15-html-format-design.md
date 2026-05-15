# HTML Page Format — Design

Status: draft, awaiting user review (2026-05-15).

## Goal

Add **HTML** as a second first-class page format alongside A2UI. The
agent gets two single-purpose tools:

- `show_ui(spec)` — emit an A2UI spec when you need a **structured
  answer** back from the user (form, picker, confirmation). _Existing
  behavior, unchanged._
- `show_html(html)` — emit an HTML page when you need to **show** the
  user a visual artifact (report, dashboard, chart, infographic,
  comparison, slide). View-only; nothing comes back.

The rule is binary: **`show_html` to show, `show_ui` to ask.** If you
need to read the user's response, use A2UI.

## Why now

PRD § _Scope V0 — out_ already names "Multi-format spec" as the
anticipated future wire-shape change. This is that change. A2UI is great
at the "structured input" lane but inadequate when the agent wants to
hand the user a rendered visual — there is no A2UI primitive for "a
report with these styled tables and inline SVG bars." HTML closes that
gap without disturbing A2UI.

## Non-goals

This spec deliberately excludes the following. Each is rejected with a
reason so future maintainers don't quietly add them back.

- **JavaScript execution.** No `<script>`, no `on*=` handlers, no
  `javascript:` URLs. _Reason: see § Structural constraint below — JS
  support is incompatible with same-origin srcdoc isolation, and we are
  not investing in subdomain isolation._
- **Submit from HTML pages.** HTML pages never produce a result; the
  state machine is `open` → expiry. _Reason: A2UI already owns the
  submit/result pipeline. Splitting that responsibility would duplicate
  a working surface for no gain. Multi-step flows already work by
  emitting a follow-up page._
- **External assets.** No external `<script src>`, `<link rel=stylesheet>`,
  `<img src=https:>`, web fonts, CDN libraries. Inline only. _Reason:
  external `connect-src` is the dominant exfiltration channel and the
  primary supply-chain attack surface. Allowing it negates most of the
  benefit of the no-JS posture._
- **Subdomain isolation.** HTML is served from the existing renderer
  origin via srcdoc. _Reason: scoped out by the product owner; no
  custom domain investment for V1._
- **Real abuse-reporting flow.** V1 ships only a `mailto:` report link.
  _Reason: a real flow is a separate project (intake form, moderation
  queue, takedown automation, SLA)._
- **Content scanning / Safe Browsing integration.** _Reason: out of
  scope for V1; revisit if abuse becomes a real signal in logs._
- **Custom TTL per format.** Both formats use the existing 30 min TTL.
  _Reason: V1 doesn't need a "shareable for longer" HTML mode and
  longer TTL grows the abuse blast radius._

## Structural constraint (load-bearing)

> **HTML pages MUST NOT execute JavaScript.** Ever.

The security model of this design rests on three layers — sandbox
attribute, CSP, sanitizer — and each layer becomes much weaker if JS
runs. Same-origin srcdoc isolation specifically is safe _only because_
no script executes; with JS enabled, an attacker-controlled page could
exfiltrate anything the renderer origin ever stored in cookies or
localStorage, register a service worker that persists across all future
Pagent visits, or beacon out via `fetch`.

Removing the `sandbox` attribute, allowing `<script>`, allowing event
handlers, or weakening the CSP `script-src` is forbidden without first
introducing wildcard subdomain isolation (separate registrable origin
per page, PSL submission, wildcard TLS, dedicated edge routing). Since
the product owner has scoped that investment out, the practical effect
is: **JS support is off the roadmap.**

This constraint is enforced by a CI test (§ Testing).

## Architecture

```
agent (MCP)              api/server.ts                Postgres
  │                          │                           │
  │ show_html(html)──────────│                           │
  │  POST /new              ─│ sanitize(html)            │
  │  {format:"html", spec}   │ INSERT pages              │
  │                          │ (format=html, state=open)─│
  │◀── { id, url }           │ map.set(id, page)         │
  │                          │                           │
user (browser)                │                           │
  │  GET /<id> ─────────────▶│ map.get(id) ─────────────▶│
  │◀── { format:"html",      │                           │
  │      spec, state, ... }  │                           │
  │                          │                           │
  ▼                          │                           │
shell (apps/web)             │                           │
  ├─ format router           │                           │
  ├─ "a2ui"  → A2UI surface  │                           │
  └─ "html"  → <iframe sandbox srcdoc="...">             │
```

Two surfaces, one router. Same backend, same storage table, same TTL,
same rate limit. The only diverging path is "what the renderer does
with the spec."

## Wire format

`POST /new` request body grows one optional field:

```ts
{
  format?: "a2ui" | "html",   // defaults to "a2ui" for backcompat
  spec: A2uiMessage[] | string  // array for a2ui, string for html
}
```

Zod schema (in `apps/api/schemas.ts`) becomes a discriminated union with
a defaulted discriminator:

```ts
const newPageBodySchema = z.union([
  z.object({
    format: z.literal("a2ui").optional().default("a2ui"),
    spec: z.unknown(),   // existing behaviour: opaque to the service
  }),
  z.object({
    format: z.literal("html"),
    spec: z.string().min(1).max(1_000_000),
  }),
]);
```

Existing clients (no `format` field) keep working — they fall through
to the A2UI branch.

`GET /:id` response grows the `format` field so the renderer can route:

```ts
{ format: "a2ui" | "html", spec, state, result, expires_at }
```

## API changes (`apps/api/`)

| File          | Change                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas.ts`  | Discriminated-union `newPageBodySchema` (above).                                                                                      |
| `app.ts`      | `POST /new`: read `format`; if `html`, run the sanitizer (§ Sanitizer) before storage. Include `format` in `GET /:id` response.       |
| `app.ts`      | `POST /:id/result`: reject with `400 invalid_for_format` when `format === "html"`. HTML pages have no result.                         |
| `app.ts`      | Body-size limit: keep current 256 KB for A2UI; bump to **1 MB** for HTML. Branch on early `format` peek before the full Zod parse.    |
| `db.ts`       | New column `format text not null default 'a2ui' check (format in ('a2ui','html'))`. Insert/select pick up the new column.             |
| `db.ts`       | `Page` type adds `format: 'a2ui' \| 'html'`.                                                                                          |
| `migrations/` | One `ALTER TABLE pages ADD COLUMN format …` migration; backfill is implicit via the default.                                          |

Storage: `spec` column stays `jsonb`. JSONB stores strings fine
(serialized as a JSON string). No type change.

## Sanitizer

Server-side, runs once on submission, before storage. We store the
sanitized output. We _also_ log the dropped tag/attribute counts for
abuse forensics, but we don't persist the raw original payload (the
sanitizer's idempotent over identity for safe inputs).

Library: **DOMPurify** running inside **jsdom** (server-side, Node 22+).
Both packages are mature, actively maintained, widely used in this
exact role.

Config (`apps/api/sanitize.ts`, new file):

```ts
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window as unknown as Window);

DOMPurify.setConfig({
  USE_PROFILES: { html: true, svg: true },
  FORBID_TAGS: [
    "script", "iframe", "frame", "frameset",
    "embed", "object", "applet",
    "link",   // no external stylesheets
    "base",   // we inject our own <base>
    "meta",   // refuses meta-refresh & meta-CSP from agent
  ],
  FORBID_ATTR: [
    "formaction",
    "srcdoc",        // no nested srcdoc
    "xlink:href",    // SVG-XSS vector
  ],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https):|mailto:|#|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i,
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: [],
  // DOMPurify strips all on* event handlers by default; explicit:
  FORBID_CONTENTS: ["script"],
  WHOLE_DOCUMENT: false,  // we wrap in our scaffold
  RETURN_TRUSTED_TYPE: false,
});

export function sanitize(html: string): {
  output: string;
  removedTags: number;
  removedAttrs: number;
};
```

Defense in depth:

| Layer          | What it stops                                                              | Where it fails              |
| -------------- | -------------------------------------------------------------------------- | --------------------------- |
| Sanitizer      | `<script>`, event handlers, `javascript:` URLs, dangerous tags             | DOMPurify bypass (rare CVE) |
| CSP            | Inline JS (`unsafe-inline` is not granted), external fetch, form submit    | Browser CSP bug             |
| `sandbox`      | Script execution at the iframe document level                              | Misconfigured attribute     |

Bypassing all three layers requires a defect in each. We accept that
absolute safety doesn't exist; the goal is "no single defect grants
script execution on the renderer origin."

## Renderer flow (`apps/web/`)

`main.ts` becomes a format router. The A2UI path is the existing code,
moved into `renderA2ui`. A new `renderHtml` handles the HTML format.

```ts
// apps/web/main.ts (sketch)
const page = await fetchPage(pageId);
if (page.format === "html") {
  renderHtml(page.spec as string);  // string after sanitization
} else {
  renderA2ui(page.spec as A2uiMessage[]);  // existing
}
```

`renderHtml` builds a scaffolded document and embeds it in a sandboxed
iframe:

```ts
function scaffold(sanitizedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<base target="_blank" rel="noopener noreferrer nofollow ugc">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>${sanitizedHtml}</body>
</html>`;
}

function renderHtml(html: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "");           // no tokens → maximum lockdown
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "");              // explicit empty Permissions-Policy
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("title", "Agent-generated content");
  iframe.srcdoc = scaffold(html);
  iframe.style.cssText = "width:100%;height:100vh;border:0;display:block";
  appElement.replaceChildren(renderChrome(), iframe);
}
```

`renderChrome` is a thin shell-side header outside the iframe with:

- a small "AI-generated content" label,
- a "Report" link → `mailto:alex@blockful.io?subject=Abuse report for page <id>&body=<id>` (V1 abuse flow).

### Iframe CSP (`IFRAME_CSP`)

```
default-src 'none';
img-src 'self' data:;
style-src 'unsafe-inline';
font-src data:;
form-action 'none';
frame-src 'none';
base-uri 'none';
sandbox;
```

Plain English per directive:

- `default-src 'none'` — block everything by default; re-enable narrowly.
- `img-src 'self' data:` — only inline images; same-origin is empty
  (opaque origin), so practically only `data:` URIs.
- `style-src 'unsafe-inline'` — inline `<style>` and `style=""` work.
  No external stylesheets (would need to be in `style-src` URLs, none
  allowed).
- `font-src data:` — inline fonts only. No CDN fonts.
- `form-action 'none'` — `<form action=…>` cannot submit anywhere.
  Phishing forms are inert.
- `frame-src 'none'` — no nested iframes.
- `base-uri 'none'` — agent can't redirect relative URLs by changing
  the base.
- `sandbox` — CSP-level sandbox, redundant with the iframe attribute,
  cheap defense-in-depth.

`frame-ancestors` is deliberately omitted. The iframe document has an
opaque origin (`sandbox` without `allow-same-origin`), so `'self'` would
fail to match the parent shell (every opaque origin is unique) and could
block our own renderer from displaying it. The shell origin already
sets `X-Frame-Options: DENY` (`apps/web/vercel.json`), which prevents
third-party sites from embedding the renderer URL — the upstream
protection that `frame-ancestors` would have provided here.

## MCP server changes (`apps/mcp/`)

Two tools instead of one. `check_result`'s return shape grows a
`format` field.

```ts
// existing — unchanged signature, sharpened description
show_ui({ spec: unknown }) -> { page_id, url, expires_at }

// new
show_html({ html: string }) -> { page_id, url, expires_at }

// existing tool — return shape grows `format` (existing
// callers that destructure { state, result } keep working).
check_result({ page_id: string }) -> { state, result, format }
```

Both `show_*` tools hit the same `POST /new` endpoint, setting the
right `format` value in the body. `check_result` now surfaces the page
format so an agent that calls it on an HTML page (against the skill's
guidance) at least gets the explicit signal `format === "html"` and
can stop polling.

### Tool descriptions

`show_ui`:

> Ask the user a question that needs a structured answer back. Forms,
> pickers, confirmations, multi-field intake. The user submits in the
> browser; poll `check_result` until the answer arrives. Use this
> whenever you need _anything_ from the user — input, a choice, a
> confirmation. If you only want to _show_ something, use `show_html`
> instead.

`show_html`:

> Show the user a rich visualization: a styled report, dashboard,
> chart, infographic, comparison table, slide, or other view-only
> artifact. The page is one-way — the user looks at it; nothing comes
> back. **Do not poll `check_result` for HTML pages; they never
> produce a result.**
>
> Constraints (enforced; violations are stripped or rejected):
>
> - No `<script>` tags, no `on*=` event handlers, no `javascript:`
>   URLs. JavaScript does not run.
> - No external assets. Inline all CSS as `<style>`. Embed images as
>   `data:image/...;base64,...` URIs. No Google Fonts, no CDN
>   libraries, no remote `<img src=https:>`.
> - No `<form>` submissions. No `<iframe>`, `<meta http-equiv=refresh>`.
> - 1 MB payload cap.
>
> If the user needs to act on what they see, follow up with a
> `show_ui` call.

## Skill prose (`skills/pagent/SKILL.md`)

Add a section at the top titled **"Picking a tool"**:

> Two tools, one rule: **`show_html` to show; `show_ui` to ask.**
>
> If anything has to come back from the user — a value, a selection,
> a click — use `show_ui`. If the user just looks at it — a report, a
> chart, a dashboard, a comparison — use `show_html`. When in doubt,
> ask yourself: "Do I need to read the user's response?" Yes →
> `show_ui`. No → `show_html`.
>
> Multi-step flows work the same way: each step is a separate page.
> Show a dashboard with `show_html`, then ask "what next?" with
> `show_ui`. Don't try to bundle visualization and input into one
> page.

The polling-pattern prose stays. Add a single line under it:

> Only A2UI pages have a result. HTML pages never transition out of
> `open` — do not poll them.

## State machine

A2UI pages: `open → submitted → received` (unchanged).
HTML pages: `open` (terminal). Page expires on TTL. No result
transition.

`POST /:id/result` on an HTML page returns `400 invalid_for_format`.
`GET /:id/result` on an HTML page returns
`{ state: "open", result: null, format: "html" }` until expiry. The
`format` field is the explicit signal to the agent: "this is HTML —
stop polling." Skill prose and MCP tool descriptions reinforce the
same instruction; the field is the load-bearing primitive.

## Body size, TTL, rate limiting

| Setting           | A2UI                | HTML                |
| ----------------- | ------------------- | ------------------- |
| Max body          | 256 KB (unchanged effective cap) | **1 MB**            |
| TTL               | 30 min (unchanged)  | 30 min              |
| Rate limit        | 30/min/IP (existing)| 30/min/IP (shared)  |

Implementation: the Hono `bodyLimit` middleware is set to 1 MB
unconditionally. The post-parse handler enforces the per-format cap —
if `format !== "html"` and the raw body exceeded 256 KB, return 413
with `{ error: "payload_too_large", format: "a2ui", max: 256000 }`.
HTML payloads above 1 MB are rejected by the middleware before the
handler runs. The exact size check (Content-Length header vs. captured
body length) is an implementation detail for the writing-plans phase
to settle against Hono's middleware ordering; the constraint is what
matters here.

## Observability

Existing Pino + OTel logging. New fields:

- `format` on every page-create log line.
- `sanitizer_removed_tags` (count) on HTML submissions.
- `sanitizer_removed_attrs` (count) same.

No new dashboards required in V1. Spike in sanitizer-removed counts is
the early signal that an agent (or attacker) is routinely emitting
something we strip — informs future allowlist tuning.

## Testing

### Unit (Vitest)

- `sanitize.ts`: one test per forbidden tag (`<script>`, `<iframe>`,
  `<object>`, `<embed>`, `<link>`, `<base>`, `<meta>`, `<applet>`,
  `<frame>`, `<frameset>`) asserting the tag is stripped from the
  output.
- `sanitize.ts`: one test per dangerous attribute (`onclick`, `onload`,
  `onerror`, `formaction`, `srcdoc`, `xlink:href`).
- `sanitize.ts`: one test per blocked URI scheme (`javascript:`,
  `vbscript:`, `data:text/html`, `data:application/javascript`).
- `sanitize.ts`: idempotency — sanitizing a clean payload returns it
  unchanged.
- `schemas.ts`: discriminated-union acceptance/rejection per format.
- `app.ts`: body limit per format, 413 cases for both.
- `app.ts`: `POST /:id/result` returns `400 invalid_for_format` on an
  HTML page.

### Renderer (Vitest + happy-dom or Playwright)

- HTML page renders with `iframe[sandbox=""]` (empty string, no tokens)
  and `srcdoc` containing the scaffolded document.
- Iframe's srcdoc contains the strict CSP meta tag at the top of
  `<head>`.
- A2UI path is unaffected (no iframe, A2UI surface renders).

### E2E (Playwright)

- Submit an HTML payload containing each of:
  - `<script>alert(1)</script>`,
  - `<form action="https://attacker.example">…</form>`,
  - `<meta http-equiv="refresh" content="0;url=https://attacker.example">`,
  - `<img src="https://attacker.example/pixel.png">`,
  - `<a onclick="…">`,
  - `<iframe src="https://attacker.example">`.
- Open the rendered URL.
- Assert: no network requests to `attacker.example` (Playwright
  intercept), no top navigation, no `alert` fired, no script in the DOM
  (via the iframe content tree).

### CI tripwire

A test in `apps/web/` that loads the iframe code path and asserts:

```ts
expect(iframe.getAttribute("sandbox")).toBe("");
expect(iframe.getAttribute("sandbox")).not.toContain("allow-scripts");
expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
```

A test in `apps/api/` that asserts the sanitizer config does not allow
`<script>`:

```ts
expect(sanitize("<script>1</script>").output).not.toContain("<script");
```

## Migration

This codebase has no separate migrations directory — schema is bootstrap
in `apps/api/db.ts`'s `init()` (`create table if not exists pages …`).
Two changes there:

1. Add `format` to the create-table block so fresh deployments get it:

   ```ts
   await sql`
     create table if not exists pages (
       id           text primary key,
       spec         jsonb       not null,
       format       text        not null default 'a2ui'
                                check (format in ('a2ui','html')),
       state        text        not null check (state in ('open','submitted','received')),
       result       jsonb,
       created_at   timestamptz not null default now(),
       expires_at   timestamptz not null,
       submitted_at timestamptz,
       received_at  timestamptz
     )
   `;
   ```

2. Add an idempotent `ALTER TABLE` immediately after, so existing
   deployments pick up the column without manual intervention:

   ```ts
   await sql`
     alter table pages
       add column if not exists format text
         not null default 'a2ui'
         check (format in ('a2ui','html'))
   `;
   ```

Backfill is implicit via the default — every existing row inherits
`format = 'a2ui'`. Both statements are idempotent and safe to run on
every boot.

## Rollout

Land in **one PR** as three logical commits in order:

1. **API + storage** — Zod discriminator, sanitizer, body-limit branch,
   schema update, `POST /:id/result` rejection for HTML, `format` in
   `GET /:id` and `GET /:id/result` responses. Includes API unit tests.
2. **MCP** — `show_html` tool added, `show_ui` description sharpened,
   tool registry updated. Includes MCP smoke test.
3. **Renderer + skill** — format router, scaffold + iframe rendering,
   chrome with Report link, `SKILL.md` updated. Includes renderer
   tests and the Playwright E2E.

Each commit individually leaves the tree green. Pre-commit-2 code, the
API has the new format but no MCP tool calls it (manual `curl` works,
agents don't change). Pre-commit-3, the API + MCP accept HTML but the
renderer hasn't shipped — the JSON `GET /:id` returns `format: "html"`,
the renderer (still on the old version until Vercel redeploys) would
render the spec as A2UI and fail. So **commits 1 and 2 can ship to
Railway only after commit 3 has reached Vercel.** Practical sequencing:
merge the PR, wait for Vercel to deploy the renderer, then redeploy
Railway. Both auto-deploy from `main` per existing CD.

## Open questions

None blocking implementation. Future considerations to revisit when V1
ships:

- Sanitizer-removed-tag dashboards: are agents routinely emitting
  things we strip that we could safely allow (e.g. inline SVG features
  not in the default profile)?
- Should A2UI pages bump to 1 MB too, or stay 256 KB? V1 keeps them at
  256 KB — no real-world ceiling reports yet.
- Abuse-reporting flow upgrade from `mailto:` → real intake form +
  moderation queue. Spec separately when traffic justifies it.
- Custom domain → wildcard subdomain isolation, if the JS-support
  question ever comes back.

## Decisions summary

| Decision                           | Chosen                                          | Rejected                                                  |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Adding HTML alongside A2UI         | Yes, both first-class                           | HTML replaces A2UI / A2UI-only                            |
| JS in HTML                         | None ever (structural)                          | Inline JS / allowlisted CDN scripts / unrestricted        |
| Submit in HTML                     | None (view-only)                                | `<form action>` direct POST / `postMessage`               |
| Origin isolation                   | Same origin, srcdoc, opaque-sandbox             | Wildcard subdomain (Approach 2)                           |
| Sanitization                       | Server-side DOMPurify+jsdom, strict denylist    | Trust agent / client-side only / no sanitization          |
| External assets                    | None (inline only)                              | Allowlisted CDNs / Google Fonts / `https:` images         |
| Body cap (HTML)                    | 1 MB                                            | 256 KB (too tight with data URIs) / 5 MB (overkill)       |
| Body cap (A2UI)                    | 256 KB (unchanged)                              | Uniform 1 MB                                              |
| TTL                                | 30 min for both                                 | Longer TTL for HTML                                       |
| MCP tool                           | Two tools: `show_ui`, `show_html`               | One tool with `format` flag / brand-new endpoint          |
| Result polling for HTML            | Never transitions; advise agent not to poll     | Synthesize a "viewed" state                               |
| Abuse flow V1                      | `mailto:` Report link only                      | Full intake form + moderation queue                       |
