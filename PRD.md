# PRD — Agent UI Session *(working title)*

## Problem
Terminal-bound AI agents (Claude Code, Cursor, Aider, ChatGPT CLI, custom Python/TS agents) can't render UI. Today they emit text or markdown. Generative-UI frameworks (A2UI, Vercel `streamUI`, CopilotKit) require a renderer the **host application** owns — incompatible with any environment where the agent doesn't control the display.

## Solution
A hosted service that lets **any agent** produce rich, interactive UI for its user — without owning a renderer. The agent emits a UI spec to the service and prints a short URL. The user clicks; the rendered UI opens in the browser. The user interacts; the agent reads the resulting state via API and continues.

## Core flow
```
agent  ──create_session──▶  service             { id, url } returned
agent  prints URL → user clicks → browser renders UI
user   submits / clicks → service captures events
agent  ──wait_for_event(id)──▶ service          returns next event
```

## Concepts
- **Session** — ephemeral, isolated container with a unique short URL. Default TTL ~30 min.
- **Surface** — the current UI spec (A2UI v0.9 JSON in V0; format-tagged so swappable later).
- **Events** — user interactions queued for the agent (form submits, button clicks).
- **Updates** — agent can replace the surface at any time, enabling multi-turn UI.

## REST API (V0)
```
POST   /sessions                    -> { id, url, ttl }
PUT    /sessions/:id/surface        body: { format: "a2ui-v0.9", spec: <opaque> }
GET    /sessions/:id/events?since=N -> { events: [...], cursor: N }   (SSE)
DELETE /sessions/:id
```
Surface body is **opaque + format-tagged** — A2UI today, anything else tomorrow without breaking clients.

## Distribution: MCP + Skill (no public SDK in V0)
**MCP server** exposes two tools:
- `show_ui(spec) -> { session_id, url }` — creates session, sets surface, returns immediately.
- `wait_for_event(session_id, timeout_s?) -> event` — long-polls (default 25s, well under MCP host timeouts).

**Skill file** (`SKILL.md`) ships alongside the MCP server. Teaches the agent the call pattern:
> "When you need user input or want to show a dashboard, call `show_ui` with an A2UI surface, then `wait_for_event` until the user responds."

The two-tool pattern (the "B" answer) is the hard-problem call: explicit, robust to host timeouts, no webhooks.

## Renderer
A static page served at `/{session_id}` that mounts the existing **A2UI Lit shell** and pulls the surface + events from the REST API. Reuse, don't reinvent.

## Storage (V0)
In-memory `Map<sessionId, Session>` with TTL eviction. No DB. Single-process. Persistence is V1.

## Scope V0 — in
- Anonymous shareable-link sessions (security via 128-bit random IDs)
- A2UI v0.9 surfaces only
- Single-user, single-tab session
- MCP server (TS) + Skill file
- Long-poll `wait_for_event`

## Scope V0 — out
- Auth / per-user sessions, public SDK, multi-tab sync, custom themes, persistence beyond TTL, charts/tables/components not in A2UI catalog.

## Stack (recommended)
- Backend: **TypeScript + Hono** on Bun or Node (single-file capable).
- Renderer: static HTML embedding the A2UI Lit shell, fetches state via REST/SSE.
- MCP server: separate package using `@modelcontextprotocol/sdk`.
- Deploy: Cloudflare Workers or Fly. Localhost for demo.

## Success criteria (V0)
- Agent in Claude Code calls `show_ui` → user sees working form in browser within **2 s**.
- Agent receives form submission as structured event within **1 s** of user click.
- MCP server install is one config line; Skill file is drop-in.
- End-to-end demo runs locally with `bun run dev` (or equivalent).

## Open questions (deferred, not blockers)
- Hosting (CF Workers vs Fly vs self-host) — defer until first real deploy.
- Terminal URL clickability (iTerm vs Alacritty vs Windows Terminal) — handle in Skill prose.
- Rate limits / abuse — add per-IP cap when public.
