# Pagent — Copy & App Change List

> 2026-06-04. Prioritized changes to make Pagent launch-ready. Grounded in the [audit](./01-current-state-audit.md) and the launch decisions (ecosystem-wide audience, adoption north-star, full-v2-then-launch).

**The throughline of every change:** (1) speak to the *whole MCP ecosystem*, not Claude-Code-only; (2) surface *both* `show_ui` (forms) and `show_html` (dashboards) — half the product is currently hidden; (3) kill insider jargon; (4) make every shared link and every install dead-simple, because the goal is **adoption**.

---

## P0 — Must-fix hygiene (true regardless of strategy; cheap; do before any traffic)

| # | Change | Where | Why |
|---|--------|-------|-----|
| 1 | `<title>` "Agent UI" → **"Pagent — Generative UI for AI agents"** | [apps/web/index.html](../../apps/web/index.html) (line ~7) | Old brand ships in the tab + search results today |
| 2 | Add a **meta description** | [apps/web/index.html](../../apps/web/index.html) | None exists; controls the search snippet |
| 3 | Add **Open Graph + Twitter card + a 1200×630 share image** | [apps/web/index.html](../../apps/web/index.html) + new asset | The big one. The launch *is* shared links (PH/X/Reddit/Discord). Every paste currently previews blank. |
| 4 | Verify **favicon** is a real Pagent mark | [apps/web/public/favicon.svg](../../apps/web/public/favicon.svg) | Brand consistency in tabs/bookmarks |
| 5 | **Decide RLS posture** on `public.pages` (enable + policy, or document why the anon key is never exposed) | Supabase | Critical advisory; make it a deliberate call before the spotlight |

### Proposed meta block (drop into `<head>`)

```html
<title>Pagent — Generative UI for AI agents</title>
<meta name="description" content="Let any AI agent show you real browser UI — interactive forms it reads your answer back from, plus dashboards and reports. Works in any MCP client. Free, no signup." />
<meta property="og:type" content="website" />
<meta property="og:title" content="Pagent — Generative UI for AI agents" />
<meta property="og:description" content="Your terminal agent can't show you a UI. Now it can. Forms and dashboards in the browser, from any MCP client. No signup." />
<meta property="og:image" content="https://pagent.link/og.png" />
<meta property="og:url" content="https://pagent.link" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Pagent — Generative UI for AI agents" />
<meta name="twitter:description" content="Forms and dashboards in the browser, from any MCP client. Free, no signup." />
<meta name="twitter:image" content="https://pagent.link/og.png" />
```

---

## P1 — Positioning rewrite (ecosystem-wide + both tools + benefit-led)

### 6. Hero — currently forms-only and "terminal agents." Proposed:

> **H1:** Your AI agent can't show you a UI. Now it can.
>
> **Lede:** Pagent lets any terminal agent render real browser UI — interactive **forms** it reads your answer back from, and rich **dashboards and reports** you just look at. The agent posts a spec, prints a short link, and waits. You open it, do the thing, and the conversation keeps going. **Works in Claude Code, Cursor, Codex, Cline — any MCP client. Free, no signup to try.**

Drops "single-shot / no host app required / A2UI v0.9" from the hero (keep deeper down / in README); adds the `show_html` half + the cross-ecosystem line. File: [apps/web/home.ts](../../apps/web/home.ts).

### 7. Add a `show_html` showcase to the landing
A screenshot/embed of an agent-generated **dashboard or report**, beside the form demo. The current terminal demo ("ask me my favorite color") only sells forms.

### 8. Reframe install ([apps/web/home.ts](../../apps/web/home.ts))
Lead with the **universal HTTP-MCP one-liner** (the ecosystem-wide hero), then per-client snippets in tabs: Claude Code (`/plugin` 2-liner), Cursor, Codex/Cline (`mcp.json`). The clever paste-prose prompt becomes one option, not the only one.

### 9. Rewrite the marketplace / plugin description
Files: [.claude-plugin/marketplace.json](../../.claude-plugin/marketplace.json) + [.claude-plugin/plugin.json](../../.claude-plugin/plugin.json). Keep it benefit-led; strip implementer jargon (the Claude listing audience is end users):

> **Current:** "…via the A2UI protocol. Ships a stdio MCP and skill, with hosted rendering at pagent.link or self-hosted via PAGENT_URL."
>
> **Proposed:** "Let your AI agent show you real browser UI — forms it reads your answer back from, plus dashboards and reports you just view. Instead of faking a form in chat, your agent prints a short link; you open it, fill it out, and it continues. Free to try, no signup."

Keep `category: productivity`. Add `cursor`, `codex`, `mcp-server` to keywords for discoverability.

---

## P2 — v2-launch + adoption assets (needed because you're launching the *full* product, demo-led)

- **10. Always-on demo page** — a permanent, non-expiring example URL people open *without installing* (pages TTL-evict at 30 min, so a dedicated showcase route is needed). One-click "see the magic" is the highest-converting asset for an adoption launch. *(small build)*
- **11. 10–20s demo video/GIF** at the top of README + landing + the X launch. For this category, the demo *is* the pitch ([research §demo video](./03-research-agent-tool-launches.md)).
- **12. v2 features section** — one benefit line each for accounts, public forms, webhooks, custom URLs, file uploads (so the "full v2" you're building shows up in the story).
- **13. Per-client quickstarts** (Cursor/Codex/Cline/OpenCode), not just Claude Code — adoption goal + ecosystem audience demands frictionless onboarding per client.
- **14. README top-fold** — add a hosted "try it now, no install" link and the demo GIF above the fold.

---

## Suggested sequencing
P0 (1–4) and the P1 copy rewrites (6, 9) are concrete and low-risk — do them first. The OG share image (3), demo page (10), and demo video (11) are design/build tasks to scope during the v2 runway. RLS (5) is a one-decision security item to close before launch.
