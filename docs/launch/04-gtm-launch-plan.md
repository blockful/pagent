# Pagent — GTM / Launch Campaign

> 2026-06-04. Built on the [research](./03-research-agent-tool-launches.md) (adversarially verified) and the launch decisions: full-v2-then-launch, ecosystem-wide audience, adoption north-star. **Channel playbooks for Reddit/Discord and the Runway section will be enriched by research round 2 (in progress).**

## 0. What the research changed about the plan

- **Your zero-login design is the single biggest launch asset.** The top-verified onboarding lever is "first meaningful action, no signup, in seconds" — Pagent satisfies it by construction, so the operative move becomes the **demo/video**. Protect "no signup to try" at all costs.
- **Cross-ecosystem positioning is empirically right** (70% run 2–4 tools; comps mcp-use and Arcade won leading vendor-neutral).
- **Do NOT chase** Product Hunt *rank*, GitHub *stars*, or *registry presence* as success metrics — all shown weak/refuted. (mcpfinder: official registry + 25K catalog + **9 stars**.)
- **A big pre-launch waitlist is not a prerequisite** (refuted 0-3). Don't build the launch around one.

## 1. Strategic spine

**Positioning:** Lead **ecosystem-wide** — *"Generative UI for any AI agent. Works in any MCP client. No signup."* — and make **Claude Code the highest-density beachhead** within that message (most-loved host at 46%, while multi-tool usage validates the cross-ecosystem story). Ecosystem-wide message, Claude-Code-first onboarding polish.

**North-star metric** (answers an explicit research gap): for a zero-login tool, stars/rank/signups are poor proxies. Define adoption as **active renders**:
- **Primary:** weekly active renderers (distinct sources calling `show_ui`/`show_html`/week) + total successful renders/week.
- **Activation:** % of installs producing a first successful render within 24h.
- **Retention:** week-2 repeat-render rate.
- **Top-of-funnel (not the goal):** installs (plugin + HTTP-MCP adds), registry/directory listings.

You already have the Grafana Product dashboard ([infra/observability](../../infra/observability)) — **instrument this funnel before launch** so the launch proves adoption, not vanity. This is the most important pre-launch task that isn't a feature.

## 2. The launch runway (mapped to "full-v2-then-launch")

| Phase | When | Goal | Key moves |
|------|------|------|-----------|
| **0 · Foundation** | Now → during v2 build | Be launch-ready | Instrument north-star funnel; ship P0 copy + OG image; build always-on demo page + 15–20s demo video; publish to official MCP Registry; claim aggregator listings |
| **1 · Build-in-public + beta** | Mid–late build | Proof + footage + allies | Founder posts real build progress on X (demo clips, not hype); recruit ~10–20 design partners across Claude Code / Cursor / Cline communities; collect testimonials + usage |
| **2 · Launch moment** | v2 shipped + funnel live | Concentrated attention → activation | Sequenced: **Show HN** (day A) → **Product Hunt** (day B) → **X demo thread** (launch day) → **Reddit/Discord** seeding (rolling). Founder present all day to reply |
| **3 · Flywheel** | Post-launch | Convert attention → retained use | Publish activation milestones; ship example/template gallery; keep shipping-in-public; double down on channels that converted |

> The research is **thin/unverified on runway tactics** (the one adjacent claim — a 400-person waitlist — was refuted). Phase 1 is therefore framed as cheap, high-signal *qualitative* work (feedback + footage + early adopters), not a waitlist-scale bet. Round-2 research targets this directly.

## 3. Channel playbooks (grounded, with what to avoid)

### Hacker News — Show HN *(strongest evidence base)*
- **Lean into genuine open-source.** Pagent is MIT, and HN measurably over-indexes on real OSS. Put it in the title: *"Show HN: Pagent – open-source generative UI for AI agents (works in any MCP client)."*
- **Modest, builder-to-builder voice. No superlatives.** **CTA = feedback, not conversion.**
- Link the **zero-install demo** first; founder replies all day.
- **Avoid (refuted):** agonizing over posting *timing* or treating the "Show HN" tag as magic — neither survived verification.

### Product Hunt *(optimize for activation, not rank)*
- **Lead with the live-demo video** naming the pain in ~5s (agent fakes a form in chat → cut to a real Pagent form returning structured data).
- **First action = open the demo, no signup** — your built-in edge. Tagline cross-ecosystem.
- **Measure traffic→activation, not upvotes.**
- **Avoid (refuted):** "video = 2.7× upvotes," "need 400 warm emails," "MCP-tagged launches get disproportionate engagement," serial-relaunch magic.

### X/Twitter — demo-led
- **The demo is the pitch.** Short screen-recordings (agent→real-UI→result), weekly during the build (build-in-public), then a founder launch-day thread. Treat each clip as a *live demo, outcome first*.
- *(X-specific tactics were lighter in the evidence; this leans on the verified demo-video findings. Round 2 may add more.)*

### Reddit + Discord — native seeding *(lowest evidence — treat as participation, not "launch")*
- No surviving verified claims yet (round-2 target). Interim judgment: participate genuinely in r/ClaudeAI, r/mcp, r/Cursor, r/LocalLLaMA and the Anthropic/MCP/Cursor Discords; lead with the demo + "free, no login"; answer questions; **never drop-and-run.** Seed where people already ask "how do I get my agent to show a UI?"

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
- Comp mismatch: Arcade's `arcade-mcp` builds servers; Pagent *is* a tool — messaging transfers, adoption mechanics may not.
- Under-researched (round 2): Reddit/Discord seeding and pre-launch runway playbooks.

---

## Immediate next actions (all doable during the v2 build)
1. Ship **P0 copy + OG image** ([doc 02](./02-copy-and-app-change-list.md)).
2. **Instrument the north-star funnel** in Grafana.
3. Build the **demo video + always-on demo page**.
4. **Register on the MCP Registry** (after verifying ingestion).

So launch day is purely about attention → activation.
