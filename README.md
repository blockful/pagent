# Agent UI Session

Hosted UI rendering for terminal-bound AI agents. The agent emits an A2UI surface to this service, prints a short URL, and reads the user's interactions back via API.

See [PRD.md](./PRD.md) for the design and [HANDOFF.md](./HANDOFF.md) for build context.

## Layout

```
server.ts                            # REST + SSE service (Hono, single file)
client/                              # Vite-served renderer (mounts @a2ui/lit's <a2ui-surface>)
mcp/                                 # stdio MCP server: show_ui + wait_for_event
skills/agent-ui-session/SKILL.md     # drop-in skill teaching the call pattern
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

Open `http://localhost:8788/<session_id>` to view a session.

## Install as a Claude Code plugin (local)

The plugin bundles the MCP server and the skill. With the dev server running (above) and from a fresh terminal:

```bash
claude --plugin-dir /absolute/path/to/agent-ui-session
```

Inside that Claude session, `show_ui` and `wait_for_event` are now callable tools and the skill is discoverable. Try:

> "Use the agent-ui-session skill to ask me my favorite color via a UI form."

`AGENT_UI_SESSION_URL` (default `http://localhost:8787`) overrides which service instance the MCP server talks to. To point at a remote deployment, export it before launching Claude.

### Production-install gaps

This is **not yet** a one-command public install. Two things are needed for that:

1. **Hosted REST service.** Right now the plugin assumes you can reach `http://localhost:8787`. For others to use it without running anything, the service has to be deployed somewhere stable and the plugin defaulted to that URL.
2. **Plugin distribution.** Either publish a release `.zip` (then users do `claude --plugin-url <url>`), or list it in a marketplace (then users do `/plugin install agent-ui-session`).

Until both are done, the install path above is "clone repo + run dev server + plug in locally".

## API

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
# follow the printed URL, fill the form — wait_for_event resolves with the action
```
