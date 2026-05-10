# Agent UI Session

Hosted UI rendering for terminal-bound AI agents. The agent emits an A2UI surface to this service, prints a short URL, and reads the user's interactions back via API.

See [PRD.md](./PRD.md) for the design and [HANDOFF.md](./HANDOFF.md) for build context.

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
    ├── server.ts
    └── smoke.mjs
skills/agent-ui-session/SKILL.md     # drop-in skill teaching the polling pattern
.claude-plugin/plugin.json           # Claude Code plugin manifest
.mcp.json                            # plugin's MCP server registration
```

The repo doubles as a Claude Code plugin: `.claude-plugin/`, `skills/`, and `.mcp.json` at the repo root make it installable with `claude --plugin-dir <path>`. The skill stays at the root because Claude Code's plugin loader looks for `skills/` next to `.claude-plugin/`, even though the skill conceptually belongs to `apps/mcp/`.

## Quick start (development)

```bash
git clone <this-repo>
cd agent-ui-session
npm install                         # workspaces install for all three apps
npm run dev                         # API on :8787, renderer on :8788
```

Open `http://localhost:8788/<page_id>` to view a page.

## Install as a Claude Code plugin (local)

The plugin bundles the MCP server and the skill. With the dev server running (above) and from a fresh terminal:

```bash
claude --plugin-dir /absolute/path/to/agent-ui-session
```

Inside that Claude session, `show_ui` and `check_result` are now callable tools and the skill is discoverable. Try:

> "Use the agent-ui-session skill to ask me my favorite color via a UI form."

`AGENT_UI_SESSION_URL` (default `http://localhost:8787`) overrides which service instance the MCP server talks to. To point at a remote deployment, export it before launching Claude.

### Production-install gaps

This is **not yet** a one-command public install. The deploy targets below are wired up; a public release still needs:

1. A live **Railway** deployment of `apps/api/` (so the plugin doesn't depend on `localhost:8787`).
2. A live **Vercel** deployment of `apps/web/` (so the user-facing URL points at a real host).
3. Plugin distribution: publish a release `.zip` (users do `claude --plugin-url <url>`) or list in a marketplace (users do `/plugin install agent-ui-session`).

Until those are done, the install path above is "clone repo + run dev server + plug in locally".

## Deploy

### `apps/api/` → Railway

`apps/api/railway.json` contains the build + start config. To deploy:

1. Create a new Railway service from this repo.
2. Set **Root Directory** to `apps/api` so Railway picks up the railway.json.
3. Set environment variables (see `apps/api/.env.example`):
   - `PUBLIC_URL` — the Vercel URL of `apps/web` (e.g. `https://agent-ui-session.vercel.app`). Used in `show_ui` responses.
   - `ALLOWED_ORIGINS` — comma-separated origins allowed to call the API (set to your Vercel URL).
   - `PORT` — Railway sets this automatically; the server reads it.
   - `PAGE_TTL_MS` — optional; default 30 minutes.
4. Deploy. Railway runs `npm install` (which walks up to the workspace root) and starts the API with `npm -w @agent-ui-session/api run start`.

The `/health` endpoint is configured as the healthcheck path.

### `apps/web/` → Vercel

`apps/web/vercel.json` handles the build. To deploy:

1. Create a new Vercel project from this repo.
2. Set **Root Directory** to `apps/web` so vercel.json is picked up.
3. Set environment variables (see `apps/web/.env.example`):
   - `VITE_API_URL` — the Railway URL of `apps/api` (e.g. `https://agent-ui-session-api.up.railway.app`). Inlined at build time, so a redeploy is needed if this changes.
4. Deploy. Vercel runs `npm install` from the monorepo root (workspace install) and `npm run build:web`, outputting `apps/web/dist/`.

The web app falls back to relative paths when `VITE_API_URL` is unset, so dev (`npm run dev`) still works through Vite's proxy.

### Order matters

Deploy Railway first to get the API URL. Then deploy Vercel with `VITE_API_URL` set to it. Then go back to Railway and set `PUBLIC_URL` + `ALLOWED_ORIGINS` to the Vercel URL.

## API

```
POST   /new                  body: { spec }     -> { id, url, expires_at }
GET    /:id                                     -> { spec, state, result, expires_at }
POST   /:id/result           body: <action>     -> { ok }              (browser submits)
GET    /:id/result                              -> { state, result }   (agent reads, marks "received" on first read)
```

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
curl -s -X POST http://localhost:8787/new \
  -H 'content-type: application/json' \
  -d '{"spec":[{"createSurface":{"surfaceId":"main","catalogId":"https://a2ui.org/specification/v0_9/basic_catalog.json"}},{"updateComponents":{"surfaceId":"main","components":[{"id":"root","component":"Column","children":["t","f","s"]},{"id":"t","component":"Text","text":"Color?"},{"id":"f","component":"TextField","label":"Color","value":{"path":"/color"}},{"id":"sl","component":"Text","text":"Send"},{"id":"s","component":"Button","child":"sl","variant":"primary","action":{"event":{"name":"submitted","context":{"color":{"path":"/color"}}}}}]}}]}'
# -> { "id": "<pageId>", "url": "http://localhost:8788/<pageId>", "expires_at": ... }

# 2. Open the URL in a browser and click Send. Then poll:
curl -s http://localhost:8787/<pageId>/result
# -> { "state": "open",      "result": null }       (before submit)
# -> { "state": "submitted", "result": { ... } }    (first read after submit; flips to received)
# -> { "state": "received",  "result": { ... } }    (subsequent reads)
```
