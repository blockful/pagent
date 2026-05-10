# Agent UI Session

Hosted UI rendering for terminal-bound AI agents. The agent emits an A2UI surface to this service, prints a short URL, and reads the user's interactions back via API.

See [PRD.md](./PRD.md) for the design and [HANDOFF.md](./HANDOFF.md) for build context.

## Layout

```
server.ts                            # REST service (Hono, single file)
client/                              # Vite-served renderer (mounts @a2ui/lit's <a2ui-surface>)
mcp/                                 # stdio MCP server: show_ui + check_result
skills/agent-ui-session/SKILL.md     # drop-in skill teaching the polling pattern
.claude-plugin/plugin.json           # Claude Code plugin manifest
.mcp.json                            # plugin's MCP server registration
```

The repo doubles as a Claude Code plugin: `.claude-plugin/`, `skills/`, and `.mcp.json` make it installable with `claude --plugin-dir <path>`.

## Quick start (development)

```bash
git clone <this-repo>
cd agent-ui-session
npm install
npm run dev          # API on :8787, renderer on :8788
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

This is **not yet** a one-command public install. Two things are needed for that:

1. **Hosted REST service.** Right now the plugin assumes you can reach `http://localhost:8787`. For others to use it without running anything, the service has to be deployed somewhere stable and the plugin defaulted to that URL.
2. **Plugin distribution.** Either publish a release `.zip` (then users do `claude --plugin-url <url>`), or list it in a marketplace (then users do `/plugin install agent-ui-session`).

Until both are done, the install path above is "clone repo + run dev server + plug in locally".

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
node mcp/smoke.mjs
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
