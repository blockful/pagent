# Pagent — Current-State Audit

> 2026-06-04. Snapshot of launch-readiness across product, copy, usage, and security.

## One-line read

Pagent is a **finished, deployed, genuinely well-engineered** product that is effectively **pre-launch**. The gap between here and a "nice launch" is almost entirely **positioning, copy, and shareable assets + a distribution plan** — not engineering.

## ✅ What's live and solid

- **The whole spine works in production.** `api.pagent.link` is healthy (`{"ok":true,"db":"ok"}`), the renderer is live at `pagent.link`. Architecture is clean: Hono REST API + Vite/Lit renderer + dual MCP (bundled **stdio** _and_ in-process **HTTP** transport, so it works in Claude Code, Cursor, Codex, Cline, etc.). Supabase persistence + self-hosted Grafana observability are wired.
- **Two real capabilities**, not one:
  - `show_ui` — interactive forms/pickers/wizards; the result comes back to the agent via polling.
  - `show_html` — view-only dashboards/reports/infographics (sandboxed, JS-stripped, 1 MB cap).
- The [agent-facing tool descriptions](../../apps/api/mcp/tools.ts) are excellent — the polling pattern is baked in, so the tools self-teach even in clients with no separate skill.
- **Distribution surface exists:** Claude Code plugin + marketplace, drop-in skill, HTTP-MCP one-liner. Install is genuinely low-friction.
- Solid engineering hygiene: Zod env validation, CSP/sanitization, rate limiting, tests, CI.

## 📊 Usage ("sessions") — honest read

- The `pages` table has **0 rows right now**. But pages are **TTL-evicted at 30 min**, so this only reflects the last half-hour — it is **not** a cumulative count. It indicates **no live traffic at this moment**, consistent with pre-launch.
- True cumulative usage lives in **Grafana / Railway metrics**. The **Railway MCP is currently unauthorized** (`railway login`); re-auth to pull real request volume for a hard baseline.
- **Action:** before launch, stand up a real adoption funnel in the Grafana Product dashboard (install → first render → repeat). See [doc 04 §North-star metric](./04-gtm-launch-plan.md).

## ✏️ Copy & positioning gaps

1. **`show_html` is invisible.** The [landing page](../../apps/web/home.ts) hero is _forms-only_ ("a real form, not a fake form in prose"). Half the product — agent-generated dashboards/reports — isn't shown anywhere. Biggest positioning miss.
2. **The marketplace/plugin description is developer-jargony** — "_Ships a stdio MCP and skill… self-hosted via PAGENT_URL… via the A2UI protocol_" ([marketplace.json](../../.claude-plugin/marketplace.json)). The saved positioning is that the listing audience is **end users / Claude Code users**, so this copy talks to the wrong reader.
3. **Install story is split.** The landing leads with a paste-a-prose-prompt block; Claude Code users have a cleaner two-command path. Lead with the simplest path per client.
4. **Insider terms in the hero** — "no host app required," "single-shot," "A2UI v0.9."

Full fixes with proposed copy: [doc 02](./02-copy-and-app-change-list.md).

## 🚦 Launch-readiness / technical gaps

- **Stale brand in the page `<title>`: "Agent UI"** ([index.html:7](../../apps/web/index.html)) — the old name still ships in the browser tab + search results.
- **No social/SEO meta at all** — no `meta description`, no Open Graph / Twitter card, no share image. For a launch where _every channel is a shared link_, blank link previews are an own-goal.
- **Supabase flags RLS disabled on `public.pages`** (critical advisory). Real exposure is _probably low_ (the API connects via direct Postgres `DATABASE_URL`; the browser only talks to the REST API, so the anon key isn't used client-side), but make it a **deliberate** decision before the spotlight — either enable RLS with policies, or document why the anon key is never exposed.

## 🔧 What's in flight

- **PR #22 — full v2 auth stack (OAuth 2.1 + sessions + magic link) is open**, not just spec'd.
- The other 6 v2 features (file uploads, webhooks, public forms, audit log, custom URLs, agent-submit) are spec'd-and-ready but unbuilt ([v2 roadmap](../superpowers/specs/2026-05-17-v2-roadmap-overview.md)).
- **Decision:** build full v2, then launch (see [README](./README.md)).

## Bottom line

The engineering is not the risk. The risks are: (a) launching with half the product invisible, (b) shipping with a stale name and blank link previews, and (c) measuring the launch by vanity metrics instead of active use. All three are addressed in docs 02 and 04.
