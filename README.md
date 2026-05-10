# Pagent

[![CI](https://github.com/blockful/pagent/actions/workflows/ci.yml/badge.svg)](https://github.com/blockful/pagent/actions/workflows/ci.yml)

Hosted UI rendering for terminal-bound AI agents. The agent emits an A2UI surface to this service, prints a short URL, and reads the user's interactions back via API.

- **Live API:** https://pagent.up.railway.app
- **Live renderer:** https://pagent.vercel.app

See [PRD.md](./PRD.md) for the design and [HANDOFF.md](./docs/HANDOFF.md) for build context.

## How it works

A non-technical view of what happens when your agent decides it needs a form:

```mermaid
sequenceDiagram
    autonumber
    participant U as You
    participant A as Your AI agent
    participant S as pagent
    participant B as Browser

    Note over A: A bundled skill teaches the agent <br/>when a real form beats faking one in chat.
    U->>A: "Ask me my favorite color via a UI"
    A->>A: design the form
    A->>S: show_ui(spec)
    S-->>A: short URL
    A-->>U: prints URL in your terminal
    U->>B: open URL
    B-->>U: render the form
    U->>B: fill out, submit
    B->>S: send the answer
    A->>S: check_result()
    S-->>A: your answer
    A-->>U: continues the conversation
```

In plain English: the agent reads its skill, decides a real form is the right way to ask, hands a form description to the service, and prints a short URL in your terminal. You open it in the browser, fill it out, submit. The agent reads your answer back and the conversation keeps going. The agent never sees you typing — only the final result.

## Layout

npm-workspaces monorepo. Three apps + the plugin scaffolding.

```
apps/
├── api/                             # REST service (Hono). Deployed on Railway.
│   ├── server.ts
│   ├── railway.json
│   └── .env.example
├── web/                             # Vite-served renderer. Deployed on Vercel.
│   ├── index.html, main.ts
│   ├── vite.config.ts
│   ├── vercel.json
│   └── .env.example
└── mcp/                             # stdio MCP server: show_ui + check_result
    ├── server.ts                     # source
    ├── server.bundle.js              # esbuild output, shipped to plugin users
    └── smoke.mjs
skills/pagent/SKILL.md                # drop-in skill teaching the polling pattern
.claude-plugin/plugin.json            # Claude Code plugin manifest
.mcp.json                             # plugin's MCP server registration
```

The repo doubles as a Claude Code plugin and a self-hosted marketplace: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `skills/`, and `.mcp.json` at the repo root make it installable from GitHub with two slash commands. The skill stays at the root because Claude Code's plugin loader looks for `skills/` next to `.claude-plugin/`, even though the skill conceptually belongs to `apps/mcp/`.

## Install as a Claude Code plugin

**Prerequisites:** Claude Code, Node 22+.

**1. Install** — paste these two commands into any Claude Code session:

```
/plugin marketplace add blockful/pagent
/plugin install pagent@pagent
```

The MCP server ships pre-bundled (`apps/mcp/server.bundle.js`), so there's no `npm install` step on your side — Claude Code can spawn it directly.

**2. Verify** — confirm the MCP server is connected:

```
/mcp
```

You should see `pagent` listed with `show_ui` and `check_result` tools. The plugin also ships a skill (`pagent`) that teaches the polling pattern.

**3. Use it** — try this prompt:

> "Use the pagent skill to ask me my favorite color via a UI form."

The agent calls `show_ui`, prints a URL (hosted at `https://pagent.vercel.app`), you submit, and the conversation continues.

**Point at a different service?** Set `PAGENT_URL` before launching Claude. By default the MCP talks to `https://pagent.up.railway.app`.

## Quick start (development)

```bash
git clone git@github.com:blockful/pagent.git
cd pagent
npm install                         # workspaces install for all three apps
npm run dev                         # API on :8787, renderer on :8788
npm run build:mcp                   # rebuild apps/mcp/server.bundle.js after editing server.ts
```

Open `http://localhost:8788/<page_id>` to view a page. To use the local API from a Claude session, install the plugin from the local checkout instead of the marketplace:

```bash
claude --plugin-dir /absolute/path/to/pagent
PAGENT_URL=http://localhost:8787 claude   # then talk to local API
```

### Shutdown behavior

The API handles `SIGTERM` and `SIGINT` gracefully:

1. Stops accepting new connections.
2. Waits up to 10 seconds for in-flight requests to finish.
3. Force-closes idle keep-alives if the timeout is hit.
4. Closes the Postgres pool and exits.

Railway sends SIGTERM during deploys; Ctrl+C in dev sends SIGINT.

### Quality gate

A Husky `pre-push` hook runs `typecheck → lint → format:check → test`
on every `git push`. To run it manually before pushing:

    .husky/pre-push

To bypass in an emergency: `git push --no-verify` (don't make this a habit).

## Deploy

### `apps/api/` → Railway

`apps/api/railway.json` contains the build + start config. To deploy:

1. Create a new Railway service from this repo.
2. Set **Root Directory** to `apps/api` so Railway picks up the railway.json.
3. Set environment variables (see `apps/api/.env.example`):
   - `PUBLIC_URL` — the Vercel URL of `apps/web` (e.g. `https://pagent.vercel.app`). Used in `show_ui` responses. **Required in production.** Boot fails loudly if missing.
   - `ALLOWED_ORIGINS` — comma-separated origins allowed to call the API (set to your Vercel URL). **Required in production.** API boot fails loudly if missing.
   - `PORT` — Railway sets this automatically; the server reads it.
   - `PAGE_TTL_MS` — optional; default 30 minutes.
   - `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` — optional. Per-IP rate limit on `POST /new`. Defaults: 30 / 60000 (30 req/min). Tune up for load tests.
   - `OTEL_EXPORTER_OTLP_ENDPOINT` — optional. Grafana Cloud OTLP HTTP base URL (e.g. `https://otlp-gateway-prod-us-central-0.grafana.net/otlp`). Leave unset to disable observability entirely. See `apps/api/.env.example` for the rest of the OTel envs.
4. Deploy. Railway runs `npm install` (which walks up to the workspace root) and starts the API with `npm -w @pagent/api run start`.

The `/health` endpoint is configured as the healthcheck path. Returns 200 only when the DB is reachable; 503 otherwise.

### `apps/web/` → Vercel

`apps/web/vercel.json` handles the build. To deploy:

1. Create a new Vercel project from this repo.
2. Set **Root Directory** to `apps/web` so vercel.json is picked up.
3. Set environment variables (see `apps/web/.env.example`):
   - `VITE_API_URL` — the Railway URL of `apps/api` (e.g. `https://pagent.up.railway.app`). Inlined at build time, so a redeploy is needed if this changes.
4. Deploy. Vercel runs `npm install` from the monorepo root (workspace install) and `npm run build:web`, outputting `apps/web/dist/`.

The web app falls back to relative paths when `VITE_API_URL` is unset, so dev (`npm run dev`) still works through Vite's proxy.

#### Security headers

The renderer ships with a strict Content-Security-Policy plus
HSTS / nosniff / frame-deny / referrer-policy / permissions-policy
configured in `apps/web/vercel.json`. The CSP `connect-src` allowlist
includes the production API origin (`pagent.up.railway.app`). If you
self-host the API at a different origin, edit that entry before
deploying — otherwise the browser will block API calls from the
renderer.

### Order matters

Deploy Railway first to get the API URL. Then deploy Vercel with `VITE_API_URL` set to it. Then go back to Railway and set `PUBLIC_URL` + `ALLOWED_ORIGINS` to the Vercel URL.

## API

```
POST   /v1/new                  body: { spec }     -> { id, url, expires_at }
GET    /v1/:id                                     -> { spec, state, result, expires_at }
POST   /v1/:id/result           body: <action>     -> { ok }              (browser submits)
GET    /v1/:id/result                              -> { state, result }   (agent reads, marks "received" on first read)
```

The unversioned paths (`/new`, `/:id`, `/:id/result`) remain wired to the same
handlers for the lifetime of the v1 series, but every response carries a
`Deprecation: true` header. New integrations MUST use `/v1/...`.

The `spec` body is opaque to the service. V0 assumes A2UI v0.9 — there is no `format` tag on the wire.

A page is single-shot and walks a 3-state machine: `open -> submitted -> received`. `POST /:id/result` requires `state === "open"` (otherwise 409). The first `GET /:id/result` after submit returns `state: "submitted"` and flips the page to `received`; subsequent reads return `state: "received"`. The renderer can detect that transition via `GET /:id` to upgrade its "waiting for the agent" banner.

## Smoke test

With `npm run dev` running, in another terminal:

```bash
npm run smoke
# (alias for `node apps/mcp/smoke.mjs`)
# follow the printed URL, fill the form — check_result returns the action
```

Or with curl, end-to-end:

```bash
# 1. Create a page with a spec.
curl -s -X POST http://localhost:8787/v1/new \
  -H 'content-type: application/json' \
  -d '{"spec":[{"createSurface":{"surfaceId":"main","catalogId":"https://a2ui.org/specification/v0_9/basic_catalog.json"}},{"updateComponents":{"surfaceId":"main","components":[{"id":"root","component":"Column","children":["t","f","s"]},{"id":"t","component":"Text","text":"Color?"},{"id":"f","component":"TextField","label":"Color","value":{"path":"/color"}},{"id":"sl","component":"Text","text":"Send"},{"id":"s","component":"Button","child":"sl","variant":"primary","action":{"event":{"name":"submitted","context":{"color":{"path":"/color"}}}}}]}}]}'
# -> { "id": "<pageId>", "url": "http://localhost:8788/<pageId>", "expires_at": ... }

# 2. Open the URL in a browser and click Send. Then poll:
curl -s http://localhost:8787/v1/<pageId>/result
# -> { "state": "open",      "result": null }       (before submit)
# -> { "state": "submitted", "result": { ... } }    (first read after submit; flips to received)
# -> { "state": "received",  "result": { ... } }    (subsequent reads)
```
