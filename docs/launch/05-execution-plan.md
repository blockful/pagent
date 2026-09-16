# Pagent Launch — Execution Plan

> **Historical execution snapshot (superseded 2026-09-16).** Do not use this as
> the current engineering plan. It predates the Page model, durable
> presentation analytics, `/admin`, and the exact `write`/`read` MCP contract.

> 2026-06-04. The "what we need to do" plan: everything from here to launched, sequenced. Built on [01 audit](./01-current-state-audit.md), [02 copy list](./02-copy-and-app-change-list.md), [03 research](./03-research-agent-tool-launches.md), [04 GTM plan](./04-gtm-launch-plan.md).
>
> **For workers:** the code workstreams (A, B) can be expanded into detailed TDD implementation plans under `docs/superpowers/plans/` and executed via `superpowers:subagent-driven-development`. The GTM/ops workstreams (D–G) are operational checklists, not code.

**Goal:** Ship full v2 and launch Pagent ecosystem-wide, optimized for **adoption** (active renders), without tripping the anti-patterns the research flagged (PH rank / stars / registry presence as vanity).

**Approach:** The v2 build is the long pole; everything else runs in parallel against it and converges on a single **launch-ready gate**. Launch day is then pure attention→activation, because the product, the funnel, the assets, and the distribution are already in place.

**Scope note (writing-plans Scope Check):** This is a multi-workstream program, not one code module — so it's a top-level plan sequencing seven workstreams. The two ready-to-build code workstreams (A, B) are concrete here; the v2 build (C) already has task files and is referenced, not duplicated.

---

## Critical path

```
        ┌─────────────────────────────────────────────┐
        │  WS-C  Full v2 build  (long pole · weeks)    │
        └─────────────────────────────────────────────┘
   ∥ in parallel, during the build:
        ├── WS-A  Launch hygiene & copy        (~1–2 days)
        ├── WS-B  Launch assets: demo + funnel + video + OG  (~3–5 days)
        ├── WS-D  Distribution: MCP registry + listings      (~1 day + waits)
        └── WS-E  Pre-launch runway: design partners + build-in-public (ongoing)
                                │
                                ▼
                    ◇  LAUNCH-READY GATE  ◇
                                │
                                ▼
            WS-F  Launch moment:  Show HN → PH → X → Reddit/Discord
                                │
                                ▼
            WS-G  Post-launch flywheel
```

## Decisions needed now (these unblock the plan)

1. **Launch date target** — a rough date relative to v2 completion; everything sequences off it.
2. **RLS posture** on `public.pages` — enable RLS + policies, or document why the anon key is never client-exposed (WS-A5).
3. **Railway re-auth** (`railway login`) — so the north-star funnel (WS-B2) can read real metrics and we get a usage baseline.
4. **GTM owner** — founder-led vs delegated for WS-D–G; affects cadence.

---

## Workstreams

### WS-A — Launch hygiene & copy `[eng · ~1–2 days · parallel]`

**Why:** Every launch channel is a shared link; today the `<title>` is stale, link previews are blank, and half the product (`show_html`) is invisible. **Source:** [doc 02](./02-copy-and-app-change-list.md).
**Definition of done:** Landing + listings reflect the ecosystem-wide, both-tools, no-jargon positioning; shared links render rich previews.

| Task | What                                                    | Files                                                                                                      | Done when                                                                                                            |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A1   | Brand/title/meta/OG + favicon                           | [apps/web/index.html](../../apps/web/index.html), [favicon](../../apps/web/public/favicon.svg)             | Title = "Pagent — …"; OG/Twitter tags present; a pasted link renders a preview card                                  |
| A2   | Hero rewrite + `show_html` showcase                     | [apps/web/home.ts](../../apps/web/home.ts)                                                                 | Hero names forms **and** dashboards + "any MCP client"; a dashboard demo is visible on the page                      |
| A3   | Install reframe (universal one-liner + per-client tabs) | [apps/web/home.ts](../../apps/web/home.ts)                                                                 | HTTP-MCP one-liner is primary; Claude Code / Cursor / Codex / Cline snippets available                               |
| A4   | Marketplace/plugin description rewrite                  | [marketplace.json](../../.claude-plugin/marketplace.json), [plugin.json](../../.claude-plugin/plugin.json) | Benefit-led copy (no stdio/A2UI jargon); keywords add `cursor`, `codex`, `mcp-server`; category stays `productivity` |
| A5   | RLS decision + action                                   | Supabase `public.pages`                                                                                    | RLS+policies enabled, **or** a documented rationale committed to the repo                                            |

### WS-B — Launch assets `[eng + design · ~3–5 days · parallel]`

**Why:** For this category the demo _is_ the pitch, and a real activation funnel is what makes launch day mean something (not vanity).
**Definition of done:** A one-click "see the magic" exists, the funnel reports adoption, and the demo video + OG image are ready.

| Task | What                                              | Notes                                                                                                      | Done when                                                                                     |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| B1   | Always-on demo page (non-expiring showcase route) | pages TTL-evict at 30 min today → a dedicated route exempt from eviction                                   | A permanent URL renders a sample form **and** a sample dashboard, no install                  |
| B2   | Grafana north-star funnel                         | extend [apps/api/metrics.ts](../../apps/api/metrics.ts) + [infra/observability](../../infra/observability) | Dashboard shows installs/adds, renders/week, install→first-render activation %, week-2 repeat |
| B3   | 15–20s live-demo video                            | pain in first 5s; real UI; real result                                                                     | Embeddable on landing / README / PH / X                                                       |
| B4   | OG share image (1200×630)                         | design task                                                                                                | Hosted at `/og.png`, referenced by A1                                                         |

### WS-C — Full v2 product build `[eng · the long pole · weeks]`

**Why:** Launch decision is full-v2-then-launch.
**Already planned — do NOT re-plan:** [v2 roadmap](../superpowers/specs/2026-05-17-v2-roadmap-overview.md) + the task files in [docs/superpowers/tasks/](../superpowers/tasks) (01-auth … 07-agent-submit).
**Order (from the roadmap):** (C0) merge **auth PR #22** → (C1) auth foundation → (C2) parallel: file-uploads ∥ webhooks ∥ audit-log → (C3) parallel: custom-URLs ∥ public-forms → (C4) capstone: agent-submit.
**Definition of done:** all 7 features merged, deployed, tested; env vars + migrations applied; WS-A copy updated to reflect accounts + the new features.

### WS-D — Distribution / registries `[ops · ~1 day + propagation waits · parallel]`

**Why:** Cheap ecosystem-wide visibility — but table-stakes, **not** adoption (the 9-star lesson).

| Task | What                                                                               | Done when                                                                           |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D1   | Verify MCP Registry GA + which marketplaces actually auto-ingest (research caveat) | A short committed note on current ingestion reality                                 |
| D2   | Publish to the official MCP Registry (`server.json`)                               | Listed at registry.modelcontextprotocol.io                                          |
| D3   | Claim aggregator/marketplace listings                                              | Glama, PulseMCP, Smithery, MCP.so, claudemarketplaces, Cursor directory — submitted |

### WS-E — Pre-launch runway `[founder/GTM · ongoing during build]`

**Why:** Design partners are the best-evidenced runway tactic ([doc 03 round 2](./03-research-agent-tool-launches.md)); build-in-public generates footage + relationships (not the growth bet).

| Task | What                                                              | Done when                                                                                                                 |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| E1   | Recruit ~5–12 design partners across Claude Code / Cursor / Cline | each onboarded via a lightweight commitment filter (intro call / feedback cadence)                                        |
| E2   | Build-in-public cadence on X (demo clips, ~weekly)                | a footage bank + a small engaged following                                                                                |
| E3   | Assemble the launch kit                                           | HN draft (OSS, modest, feedback CTA), PH gallery+video+first-comment, X thread, Reddit teardown post, Cursor Discord post |

### WS-F — Launch moment `[founder/GTM · launch week]`

**Gate:** start only when the Launch-Ready checklist passes.

- **F1 Sequence:** **Show HN** (day A) → **Product Hunt** (day B) → **X demo thread** (launch day) → **Reddit teardown + Cursor Discord** (rolling).
- **F2** Founder present all day on each to reply; CTA = try the zero-install demo.
- **F3** Watch the activation funnel live; capture what converts.
- **Avoid (research):** optimizing for PH rank / upvotes / stars; "Check out my tool" Reddit posts; seeding the official MCP Discord.
  **Done when:** launched across channels; activation funnel populated; learnings logged.

### WS-G — Post-launch flywheel `[founder/GTM · ongoing]`

Publish activation milestones; ship an example/template gallery; double down on channels that converted; keep shipping-in-public.

---

## Launch-Ready gate (checklist before WS-F)

- [ ] Full v2 deployed + green CI (WS-C)
- [ ] WS-A copy/positioning live; link previews render
- [ ] Always-on demo page live; demo video + OG image done (WS-B)
- [ ] North-star funnel reporting real numbers (WS-B2)
- [ ] MCP registry listing live (WS-D)
- [ ] Launch kit drafted + design partners primed (WS-E)
- [ ] RLS decision closed (WS-A5)

## What I can expand next

- **WS-A** and **WS-B** into detailed, TDD-style implementation plans under `docs/superpowers/plans/` (exact files, tests, steps), then execute via `superpowers:subagent-driven-development`.
- **WS-C** is already covered by the existing [task files](../superpowers/tasks).
- **WS-D–G** are operational — they become a tracked checklist (e.g., issues/Clickup), not code plans.
