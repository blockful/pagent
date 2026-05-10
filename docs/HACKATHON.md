# Agent UI Session

**TL;DR**
Give your terminal agent a UI. The agent posts a form spec, prints a URL, and waits. You open it, fill the form, submit. The agent reads the result and continues.

## What it is

Three pieces that work together:

1. **Hosted service** with a static renderer. The browser side. Mounts an A2UI surface from a spec and posts the user's submission back.
2. **MCP server** with two tools: `show_ui(spec)` returns a page id and short URL, `wait_for_result(page_id)` long-polls until the user submits.
3. **Skill file** (`SKILL.md`) that teaches the agent the call pattern in two paragraphs, so it knows when to reach for a form instead of faking one in prose.

## How to use it

Add the MCP server to your agent with one config line pointing at the hosted endpoint. Drop the Skill file into your project (or rely on the bundled one). That is the whole setup.

From then on, when your agent decides it needs structured input, it calls `show_ui` with an A2UI spec and prints the returned URL to the terminal. You click, the renderer opens in the browser, you fill the form and submit. The agent's `wait_for_result` returns the action and the conversation keeps going.

Each page is single-shot. For the next step in a flow, the agent creates a new page. That constraint kept the API to four REST endpoints with no SSE and no event log.

## Why it exists

Terminal agents like Claude Code and Cursor can only output text. When a task needs a form, they either fake it in prose or ask you to type structured input by hand. Generative UI frameworks like A2UI and Vercel's streamUI solve the rendering side, but they assume a host app owns the renderer. That breaks when the agent *is* the host: a CLI, an SSH session, an IDE extension in someone else's editor. This service is the shared rendezvous so the agent can hand off a real UI without owning one.

## Stack

Hono on Railway, Vite plus the A2UI Lit renderer on Vercel, Supabase for durability. The MCP server is a tiny TypeScript package any agent that speaks MCP picks up.
