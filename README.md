# Agent UI Session

Hosted UI rendering for terminal-bound AI agents. The agent emits an A2UI surface to this service, prints a short URL, and reads the user's interactions back via API.

See [PRD.md](./PRD.md) for the design and [HANDOFF.md](./HANDOFF.md) for build context.

## Layout

```
server.ts              # REST + SSE service (Hono, single file)
client/                # Vite-served renderer that mounts @a2ui/lit's <a2ui-surface>
mcp/                   # MCP server exposing show_ui + wait_for_event
mcp/SKILL.md           # Drop-in skill teaching the call pattern
```

## Run it

```bash
npm install                   # installs server, client, and a2ui file deps
npm run dev                   # starts API on :8787 and renderer on :8788
```

Open `http://localhost:8788/<session_id>` to view a session. The MCP server is started separately (or by the agent host):

```bash
node --experimental-strip-types mcp/server.ts
```

`AGENT_UI_SESSION_URL` (default `http://localhost:8787`) controls which API the MCP server talks to. `PUBLIC_URL` (default `http://localhost:8788`) controls the URL handed back to the user.

## API (V0)

```
POST   /sessions                       -> { id, url, ttl_ms }
GET    /sessions/:id                   -> { id, surface, expires_at, cursor }
PUT    /sessions/:id/surface           body: { format: "a2ui-v0.9", spec }
POST   /sessions/:id/actions           body: <action json>          (browser → API)
GET    /sessions/:id/events?since=N    SSE stream OR long-poll JSON  (depending on Accept)
DELETE /sessions/:id
```

The `spec` body is opaque to the service and tagged with `format`. V0 supports `"a2ui-v0.9"`.

## Smoke test

With `npm run dev` running, in another terminal:

```bash
node mcp/smoke.mjs
# follow the printed URL, click the button — wait_for_event resolves
```
