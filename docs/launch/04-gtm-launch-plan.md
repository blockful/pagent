# Pagent — GTM / Launch Campaign

> **Historical planning snapshot (superseded 2026-09-16).** This campaign plan
> predates durable presentation pages and the exact `write`/`read` MCP
> contract. Treat old names and metrics as context, not current launch copy.

> 2026-06-04. Built on the [research](./03-research-agent-tool-launches.md) (adversarially verified) and the launch decisions: full-v2-then-launch, ecosystem-wide audience, adoption north-star. The Reddit/Discord playbook and the Runway section reflect **research round 2 (complete)**.

## 0. What the research changed about the plan

- **Your zero-login design is the single biggest launch asset.** The top-verified onboarding lever is "first meaningful action, no signup, in seconds" — Pagent satisfies it by construction, so the operative move becomes the **demo/video**. Protect "no signup to try" at all costs.
- **Cross-ecosystem positioning is empirically right** (70% run 2–4 tools; comps mcp-use and Arcade won leading vendor-neutral).
- **Do NOT chase** Product Hunt _rank_, GitHub _stars_, or _registry presence_ as success metrics — all shown weak/refuted. (mcpfinder: official registry + 25K catalog + **9 stars**.)
- **A big pre-launch waitlist is not a prerequisite** (refuted 0-3). Don't build the launch around one.

## 1. Strategic spine

**Positioning:** Lead **ecosystem-wide** — _"Generative UI for any AI agent. Works in any MCP client. No signup."_ — and make **Claude Code the highest-density beachhead** within that message (most-loved host at 46%, while multi-tool usage validates the cross-ecosystem story). Ecosystem-wide message, Claude-Code-first onboarding polish.

**North-star metric** (answers an explicit research gap): for a zero-login tool, stars/rank/signups are poor proxies. Define adoption as **active renders**:

- **Primary:** weekly active renderers (distinct sources calling `show_ui`/`show_html`/week) + total successful renders/week.
- **Activation:** % of installs producing a first successful render within 24h.
- **Retention:** week-2 repeat-render rate.
- **Top-of-funnel (not the goal):** installs (plugin + HTTP-MCP adds), registry/directory listings.

You already have the Grafana Product dashboard ([infra/observability](../../infra/observability)) — **instrument this funnel before launch** so the launch proves adoption, not vanity. This is the most important pre-launch task that isn't a feature.

## 2. The launch runway (mapped to "full-v2-then-launch")

| Phase                                     | When                     | Goal                                | Key moves                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 · Foundation**                        | Now → during v2 build    | Be launch-ready                     | Instrument north-star funnel; ship P0 copy + OG image; build always-on demo page + 15–20s demo video; publish to official MCP Registry; claim aggregator listings                                                                                                 |
| **1 · Design partners + build-in-public** | Mid–late build           | Validation + footage + allies       | Recruit a **~5–12 design-partner cohort** (best-evidenced runway tactic) across Claude Code / Cursor / Cline, with a lightweight commitment filter; founder posts demo clips on X (hygiene + footage, _not_ the growth engine); collect testimonials + real usage |
| **2 · Launch moment**                     | v2 shipped + funnel live | Concentrated attention → activation | Sequenced: **Show HN** (day A) → **Product Hunt** (day B) → **X demo thread** (launch day) → **Reddit/Discord** seeding (rolling). Founder present all day to reply                                                                                               |
| **3 · Flywheel**                          | Post-launch              | Convert attention → retained use    | Publish activation milestones; ship example/template gallery; keep shipping-in-public; double down on channels that converted                                                                                                                                     |

> **Round-2 research** confirms **design partners** (~5–12 target users engaged while building) as the best-evidenced runway tactic — distinct from waitlists/betas. Adapt the enterprise "payment-as-screen" (Sierra) to a free tool via a **lightweight commitment filter** (a short call / feedback cadence) to screen for serious users. **Build-in-public is hygiene, not a proven adoption driver** — its headline ROI anecdote was refuted — so do it for relationships + footage, not as the engine. A big waitlist is explicitly **not** a prerequisite.

## 3. Channel playbooks (grounded, with what to avoid)

### Hacker News — Show HN _(strongest evidence base)_

- **Lean into genuine open-source.** Pagent is MIT, and HN measurably over-indexes on real OSS. Put it in the title: _"Show HN: Pagent – open-source generative UI for AI agents (works in any MCP client)."_
- **Modest, builder-to-builder voice. No superlatives.** **CTA = feedback, not conversion.**
- Link the **zero-install demo** first; founder replies all day.
- **Avoid (refuted):** agonizing over posting _timing_ or treating the "Show HN" tag as magic — neither survived verification.

### Product Hunt _(optimize for activation, not rank)_

- **Lead with the live-demo video** naming the pain in ~5s (agent fakes a form in chat → cut to a real Pagent form returning structured data).
- **First action = open the demo, no signup** — your built-in edge. Tagline cross-ecosystem.
- **Measure traffic→activation, not upvotes.**
- **Avoid (refuted):** "video = 2.7× upvotes," "need 400 warm emails," "MCP-tagged launches get disproportionate engagement," serial-relaunch magic.

### X/Twitter — demo-led

- **The demo is the pitch.** Short screen-recordings (agent→real-UI→result), weekly during the build (build-in-public), then a founder launch-day thread. Treat each clip as a _live demo, outcome first_.
- _(X-specific tactics were lighter in the evidence; this leans on the verified demo-video findings. Round 2 may add more.)_

### Reddit + Discord — native seeding _(round-2 evidence; caveated)_

- **Discord:** **skip the official MCP Discord** — it's contributor-only and discourages product marketing. Target the **Cursor Discord (~37K)**, which explicitly sanctions "share what you're working on" / "Built with Cursor." Treat **r/ClaudeAI + the Anthropic Discord as participate-and-learn** (research couldn't validate them — absent evidence, not disproven).
- **Reddit — format beats announcement.** Lead with a **teardown/comparison + a demo GIF** ("I made my agent render real forms instead of faking them in chat — here's how"); **be the first commenter** disclosing authorship + technical detail; **never make a Twitter/X link the primary link.** Respect each sub's promo norms — **r/SideProject** is friendliest (you'll have a shipped product); r/startups / r/Entrepreneur gate promo to designated threads.
- **Avoid:** "Check out my tool" headlines, contextless "Feedback?" posts, copy-pasted cross-posts (removed as spam). Skip the folklore ratios (9:1 / 10:1) — just genuinely participate.

## 4. Distribution: registries (table-stakes, not adoption)

- **Publish once to the official MCP Registry** (`registry.modelcontextprotocol.io`) — designed hub-and-spoke so listings propagate to client marketplaces. **Verify which marketplaces actually auto-ingest** as of mid-2026 (propagation was incomplete in late 2025; Smithery/PulseMCP/MCP.so/Glama/Cursor directory may need manual submission).
- Do it for cheap visibility — but **don't mistake it for traction** (the 9-star lesson).

## 5. Asset checklist (build during the runway)

- [ ] North-star funnel instrumented in Grafana (install → first render → repeat)
- [ ] 15–20s **live-demo video** (pain in 5s, real UI, real result)
- [ ] **Always-on demo page** (non-expiring showcase route — pages TTL at 30 min today)
- [ ] **OG/Twitter share image** + meta (P0 from [doc 02](./02-copy-and-app-change-list.md))
- [ ] Landing rewrite surfacing `show_html` + cross-ecosystem (P1)
- [ ] Per-client quickstarts (Claude Code, Cursor, Codex, Cline, OpenCode)
- [ ] MCP Registry listing + aggregator submissions
- [ ] Launch kit: HN draft, PH gallery+video+first-comment, X thread, Reddit/Discord posts

## 6. Metrics scoreboard — and what NOT to optimize for

- **Track:** weekly active renderers, renders/week, install→first-render activation %, week-2 repeat rate, demo-page→install conversion.
- **Don't optimize for:** PH rank, GitHub stars, registry catalog presence, raw signups. All weak/refuted proxies for this category.

## 7. Honest caveats (from the research's own verification)

- Channel tactics (PH/HN/X) rest largely on practitioner blogs — directional, not gospel. Best-grounded: MCP Registry architecture + comparable-launch metrics.
- Fast-moving + time-sensitive: re-check registry GA + ingestion before relying on "publish once."
- Comp mismatch: Arcade's `arcade-mcp` builds servers; Pagent _is_ a tool — messaging transfers, adoption mechanics may not.
- Round-2 caveat: Reddit tactics lean on marketing-vendor blogs (rule _descriptions_ corroborated, _efficacy_ folklore); design-partner evidence is all paid-enterprise and doesn't transfer cleanly to free self-serve. MCP-native venues (r/mcp, r/ClaudeAI, Anthropic Discord) remain unvalidated — participate and learn.

---

## Immediate next actions (all doable during the v2 build)

1. Ship **P0 copy + OG image** ([doc 02](./02-copy-and-app-change-list.md)).
2. **Instrument the north-star funnel** in Grafana.
3. Build the **demo video + always-on demo page**.
4. **Register on the MCP Registry** (after verifying ingestion).

So launch day is purely about attention → activation.
