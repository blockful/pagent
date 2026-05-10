> **Historical document — describes the pre-rename V0 design. The current API
> is documented in [README.md](../README.md) and [docs/openapi.yaml](openapi.yaml).**

# Handoff prompt for next agent

Copy everything below this line into a fresh agent session.

---

You're picking up a hackathon project. **Read `PRD.md` in this directory first — it is the source of truth.** Below is just the operational context.

## Where things stand

- `PRD.md` is finalized. Decisions locked: A2UI v0.9 as the surface format (opaque + format-tagged for future swappability), MCP + Skill as distribution (no public SDK in V0), two-tool MCP pattern (`show_ui` + `wait_for_event`) for the streaming-wait problem.
- Repo dir: `/Users/netto/work/hackathons/gen-ui-sf/agent-ui-session/` (git-init'd, no commits yet — you'll make the initial one).
- Sibling directory `/Users/netto/work/hackathons/gen-ui-sf/a2ui/` is the open-source A2UI repo, already cloned. **You will reuse its Lit-based renderer** for the session view — do not re-implement.
- A working A2UI demo is already running at http://localhost:5173 (component builder agent on :10002). You can study how the shell consumes A2UI JSON there. The relevant renderer code lives at `a2ui/renderers/lit/` and `a2ui/samples/client/lit/shell/`.

## Build order (V0, thin and elegant — no scope creep)

1. **REST service** (TypeScript + Hono on Bun or Node, single file is fine):
   - `POST /sessions` → `{ id, url, ttl }`
   - `PUT /sessions/:id/surface` body `{ format, spec }`
   - `GET /sessions/:id/events?since=N` (SSE stream)
   - `DELETE /sessions/:id`
   - In-memory `Map`, TTL eviction. No DB.
2. **Renderer page** at `GET /:session_id` — static HTML that mounts the A2UI Lit shell and subscribes to `/sessions/:id/events`. Reuse the shell from `a2ui/samples/client/lit/shell/`; minimal glue.
3. **MCP server** (separate package, TypeScript, `@modelcontextprotocol/sdk`):
   - Tool `show_ui(spec)` → calls `POST /sessions` then `PUT /surface`, returns `{ session_id, url }`.
   - Tool `wait_for_event(session_id, timeout_s=25)` → long-polls events endpoint, returns next event or null on timeout.
4. **`SKILL.md`** — short prose teaching the call pattern. Two paragraphs max.
5. **End-to-end smoke test**: a script that calls the MCP tools and prints the URL, then waits. Open the URL manually, submit, see event come back.

## Constraints / non-negotiables

- **Thin and elegant.** No DB, no auth, no public SDK, no realtime collab. If the PRD says it's V1 or out-of-scope, do not build it.
- **A2UI surface body is opaque to the service.** Tag with `format: "a2ui-v0.9"`. The service does not parse or validate the spec — only the renderer does.
- **Reuse the A2UI Lit shell** for the renderer. Do not write a fresh component renderer.
- **Long-poll, not WebSocket.** SSE for the events endpoint; the MCP `wait_for_event` tool blocks up to 25s.

## First concrete step

Stand up the REST service in a single file (`server.ts`), wire the four endpoints with in-memory storage, and verify with `curl`. That alone is ~80 lines of Hono.

## How to test as you go

- Local: `bun run dev` (or `node --watch`) → service on :8787 (or whatever port).
- Use `curl` to create a session, set a surface, hit the events endpoint.
- Once the renderer page is wired, open the returned URL in a browser; you should see the A2UI surface render.
- The MCP server can be tested standalone with the MCP inspector before plugging into Claude Code.

## What's NOT in scope yet

- Production hosting (defer until V0 works locally).
- Public SDK package (V1).
- Auth, rate limits, multi-user (V1).
- Components beyond what A2UI v0.9 already supports.

Ask before adding anything not in the PRD. Ship the spine first.
