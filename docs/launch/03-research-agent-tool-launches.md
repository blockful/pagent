# Research — How agent/MCP/dev tools actually got adopted (2025–2026)

> 2026-06-04. Deep-research pass: 21 sources fetched, 103 claims extracted, 25 adversarially verified (14 confirmed, 11 refuted), then synthesized. **Round 2 (Reddit/Discord seeding + pre-launch runway) is in progress and will be appended below.**
>
> Method note: claims were verified by a 3-vote adversarial process (a claim needed to survive refutation attempts). "Refuted" claims below failed verification and should **not** be relied on, even though several are widely repeated as launch advice.

## TL;DR

For a free, zero-login, cross-ecosystem MCP tool like Pagent, the evidence points to a clear adoption playbook: **publish once to the official MCP Registry** so the listing propagates into per-client marketplaces, but **treat directory presence as necessary-but-insufficient** — registry listing and big catalog numbers are weak adoption predictors. **Cross-ecosystem "works in any MCP client" positioning is validated** by real market behavior and by comparable launches. **Channel tactics differ sharply by venue.** The biggest anti-pattern is mistaking **vanity signals** (PH rank, catalog size, registry presence, frictionless signups) for **real adoption** — activation and repeat use are the metrics that matter.

---

## Confirmed findings

### 1. Publish once to the official MCP Registry; it propagates hub-and-spoke `[high]`

The official registry (`registry.modelcontextprotocol.io`) is "an open catalog and API… a primary source of truth" that per-client "MCP marketplaces" (Claude/Cursor/VS Code) ingest from and curate. A single publish can surface across multiple client marketplaces instead of per-client submissions. Backed by Anthropic, GitHub, PulseMCP, Microsoft.
**Caveat:** preview/pre-GA as of the Sept 2025 announcement; "publish once → everywhere" is the _intended_ federated model, **not yet universal** — Smithery, Raycast, MCP.so, PulseMCP still required separate submission in late 2025. **Verify current ingestion before relying on it.**
Sources: [MCP registry preview](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/), [registry repo](https://github.com/modelcontextprotocol/registry), [TrueFoundry](https://truefoundry.com/blog/best-mcp-registries).

### 2. Discovery runs through an aggregator layer, not one canonical directory `[medium]`

Tools like **mcpfinder** aggregate 25K+ servers across the official registry + Glama + Smithery into deduplicated, ranked catalogs that agents query directly. The ecosystem is fragmented (Glama ~21K, PulseMCP ~11,840, Smithery ~7K, plus a dozen directories).
Sources: [mcpfinder](https://github.com/mcpfinder/mcpfinder), [Show HN](https://news.ycombinator.com/item?id=47841215).

### 3. Registry/directory presence is a WEAK predictor of adoption `[medium]`

Live data point (2026-06-04): **mcpfinder has 9 GitHub stars** despite being in the official registry and indexing 25K+ servers. Presence ≠ traction. (Stars are an imperfect proxy — but that's the point: vanity signals don't track active use.)
Source: [mcpfinder GitHub](https://github.com/mcpfinder/mcpfinder).

### 4. Cross-ecosystem positioning is validated by real behavior `[high]`

The Pragmatic Engineer "AI Tooling for Software Engineers in 2026" survey (n=906, Jan–Feb 2026): **55% regularly use AI agents**; **70% use 2–4 tools simultaneously**, 15% use five+. Multi-tool reality favors tools that work across hosts.
**Nuance:** the same survey shows Claude Code is the most-loved single host (46% vs Cursor 19%, Copilot 9%) — so single-host density is real too. Read: lead ecosystem-wide, make Claude Code the first-class beachhead.
Sources: [survey relay](https://dev.to/alexmercedcoder/ai-weekly-claude-code-dominates-mcp-goes-mainstream-week-of-march-5-2026-15af) + independent corroboration.

### 5. Comparable launches show the cross-ecosystem pattern working `[high]`

- **mcp-use** ("connect any LLM to any MCP"): crossed 100K downloads (now **>1M/month**, ~10K GitHub stars, used by 397 repos).
- **Arcade "Secure MCP Framework"**: **#3-of-day / 272 upvotes** on Product Hunt (Nov 7, 2025), leading with vendor-neutral "works with LangGraph, Cursor, Claude, and more."
  **Caveat:** mcp-use's "100K / NASA" and Arcade's stats are partly self-reported (their own Show HN / PH posts); mcp-use's core adoption is independently corroborated via GitHub/PyPI. Arcade's `arcade-mcp` is a framework for _building_ servers (vs Pagent being a tool) — messaging pattern transfers, adoption mechanics may not.
  Sources: [mcp-use Show HN](https://news.ycombinator.com/item?id=44747229), [mcp-use GitHub](https://github.com/mcp-use/mcp-use), [PyPI stats](https://pypistats.org/packages/mcp-use), [Arcade PH](https://www.producthunt.com/products/secure-mcp-framework), [arcade-mcp](https://github.com/ArcadeAI/arcade-mcp).

### 6. On Hacker News, modest + open-source wins; selling backfires `[high]`

Overt selling and superlatives ("fastest/best/first") make HN "close the tab." Use modest, builder-to-builder voice; make the **CTA feedback, not conversion**; foreground **genuine open-source** (including in the title) — HN measurably over-indexes on real OSS (a 2-year study of 2,195 HN stories found OSS/AI projects get significantly more positive engagement and higher post-launch commit/PR growth).
**Caveat:** HN scrutinizes _fake_ OSS — the tactic only works because Pagent is genuinely MIT.
Sources: [Markepear](https://www.markepear.dev/blog/dev-tool-hacker-news-launch), [official HN guidelines](https://news.ycombinator.com/newsguidelines.html), [Lucas Costa](https://lucasfcosta.com/blog/hn-launch), [arXiv 2506.12643](https://arxiv.org/abs/2506.12643).

### 7. Zero-friction free trial is the top onboarding lever; demo/video is the explicit second-best `[high]`

"Remove all barriers. For free. The second best thing is a demo or video." First meaningful action must work **without email verification**, measured in seconds.
**Direct implication for Pagent:** it's _already_ zero-login and free, so the top lever is satisfied by construction — which means the operative move becomes the **demo/video**.
Sources: [Markepear](https://www.markepear.dev/blog/dev-tool-hacker-news-launch), [Hackmamba](https://hackmamba.io/developer-marketing/how-to-launch-on-product-hunt/).

### 8. Effective launch videos are live demos, not commercials `[medium]`

Show real UI / real interactions / real output; **name the pain in the first ~5 seconds**; show the outcome first; skip logo animations and feature lists.
**Caveat:** primary source is a vendor blog; directional heuristic strongly corroborated by independent practitioners (Cerebras DevX, Replit DevRel).
Sources: [demosmith](https://demosmith.ai/blog/product-hunt-launch-demo-video), [dx.tips/video](https://dx.tips/video).

### 9. Leaderboard rank is NOT the success metric — activation is `[high]`

A dev-tool launch "is not measured by upvotes alone" — real metrics are traffic, activation, docs visits, community engagement, adoption. Lower traffic with strong conversion is **not** failure. The dominant anti-pattern is over-indexing on signals that _look_ like traction (PH rank, catalog size, registry presence, frictionless signups) but don't convert.
**Nuance:** top-3 PH spots do capture most click-through, so rank has instrumental reach value — but is not the goal.
Sources: [Hackmamba](https://hackmamba.io/developer-marketing/how-to-launch-on-product-hunt/), [mcpfinder data point](https://github.com/mcpfinder/mcpfinder).

---

## Refuted — do NOT rely on these (each failed 3-vote verification)

- ❌ "HN front page → avg 121 stars/24h, 189/48h, 289/week" (specific numbers) — refuted 0-3.
- ❌ "The 'Show HN' tag itself causally boosts star growth" — refuted 0-3.
- ❌ "Posting _timing_ is the dominant predictor of viral star growth" — refuted 0-3.
- ❌ "A demo video yields ~2.7× more PH upvotes" — refuted 0-3.
- ❌ "You need a warm email list of 200–400+ or the PH upvote math fails" — refuted 0-3. **(Do not build the launch around a waitlist.)**
- ❌ "MCP/agent-tagged PH launches get disproportionate engagement" — refuted 0-3.
- ❌ "Serial/repeated PH launches drive cumulative success (Supabase 9/16)" — refuted 0-3.
- ❌ "Top-4 PH ≈ 1,500 visitors/day" — refuted 1-2.
- ❌ "mcp-use's core positioning was '6 lines of code'" — refuted 1-2.

**Takeaway:** treat quantified PH/HN ROI claims with skepticism, and don't gate the launch on a big pre-built list.

---

## Open questions (evidence was thin — Round 2 targets these)

1. **Which client marketplaces actually auto-ingest from the upstream registry** as of mid-2026 vs still need manual submission? "Publish once" is only as strong as real ingestion.
2. **Which pre-launch / runway tactics measurably drove MCP-tool adoption?** Surviving evidence is thin (the one adjacent claim — a 400-person waitlist — was refuted).
3. **Reddit/Discord community-seeding tactics for this category** — no surviving verified claims yet.
4. **The right north-star activation metric for a zero-login tool** — findings agree stars/rank/signups are poor proxies but don't name the positive metric. (Doc 04 proposes _active renders_ + repeat rate, instrumented in Grafana.)

---

## Caveats on this research

- **Source quality:** channel-tactic findings (PH/HN/video) rest largely on practitioner/agency blogs — directional, corroborated across multiple 2025–2026 sources, but not hard data. Best-grounded: the MCP Registry architecture (official primary source) and comparable-launch metrics (live GitHub/PyPI/PH pages).
- **Time-sensitivity is high:** registry GA status, ingestion coverage, and server/download counts will go stale quickly — re-verify near launch.
- **Self-reported metrics:** mcp-use's NASA name-drop is unverifiable; Arcade/mcp-use figures are partly founder-posted.

## Primary sources worth reading directly

- [Official MCP Registry announcement](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)
- [HN guidelines](https://news.ycombinator.com/newsguidelines.html) · [Markepear HN launch guide](https://www.markepear.dev/blog/dev-tool-hacker-news-launch)
- [Hackmamba PH launch guide](https://hackmamba.io/developer-marketing/how-to-launch-on-product-hunt/)
- [mcp-use Show HN](https://news.ycombinator.com/item?id=44747229) · [Arcade PH](https://www.producthunt.com/products/secure-mcp-framework)

---

## Round 2 — Reddit/Discord seeding + pre-launch runway

> Completed 2026-06-04. 25 sources fetched, 114 claims, 25 verified (13 confirmed, 12 refuted). **Heavily caveated:** the Reddit tactical findings lean on marketing-vendor blogs (conflict of interest) — rule _descriptions_ are corroborated, but _efficacy_ and quantitative cadence numbers are folklore. The design-partner evidence is all **paid B2B/enterprise** and does not transfer cleanly to a free self-serve tool.

### Confirmed findings

**Discord**

- **Skip the official MCP Discord — it's the wrong venue. `[high]`** It's explicitly "designed for MCP contributors and is not intended for general MCP support," routes users to GitHub Discussions, and discourages product/vendor marketing. No confirmed general-purpose "official MCP user" Discord exists. ([MCP community docs](https://modelcontextprotocol.io/community/communication))
- **The Cursor Discord (~37K members, ~3.6K online) is a sanctioned show-and-tell venue. `[high]`** It explicitly invites "share what you're working on" / "Showcase your new projects," with a "Built with Cursor" track. ([Cursor Discord listing](https://discord.com/servers/cursor-1074847526655643750))

**Reddit**

- **Major subreddits have real, documented anti-self-promo rules. `[high]`** r/startups → promo only in stickied "Share Your Startup" threads; r/Entrepreneur → no primary-purpose selling (+karma min); r/webdev → engagement required, promo routed to "Showoff Saturday"; **r/SideProject → the most launch-friendly, but requires a shipped product.** Direction is solid; _specific numeric thresholds (karma gates, 80/20, 10:1) were refuted_ — don't trust the numbers. ([SubredditSignals](https://www.subredditsignals.com/blog/best-subreddits-to-promote-a-tech-product-in-2026-rules-real-examples-and-outreach-tips-that-don-t-get-you-banned))
- **Post FORMAT is the dominant lever, not the announcement. `[high]`** Comparisons, teardowns, and specific-numbers breakdowns win; "Check out my tool" headlines, contextless "Feedback?" posts, and copy-pasted cross-posts fail or get removed. (The "converts highest" superlative is unproven; the success/fail format split is corroborated.)
- **Concrete tactics that reduce removal + improve conversion `[medium]`:** mix promo with genuine participation; **don't use a Twitter/X link as the primary link** (devs dislike it); **always include a demo video/GIF**; **be the FIRST commenter** under your own post to disclose authorship + add technical context; tailor the title per-subreddit. ([Tereza Tizkova](https://tereza-tizkova.medium.com/best-subreddits-for-sharing-your-project-517c433442f9))

**Pre-launch runway**

- **Design partners are the best-evidenced runway tactic. `[high]`** Engage a small cohort (~5–12 target users) _before/while_ building — to co-create and validate, categorically different from beta-testers (who QA an existing product) or waitlists. ([Bessemer Atlas](https://www.bvp.com/atlas/design-partners-the-pre-launch-edge-most-ai-founders-ignore), a16z)
- **Design partners can convert to real adoption — but mind the disanalogy. `[high]`** Sierra reports 100% of its (4) design partners converted to paying customers, _because_ it charged them 10–20% of contract value as a seriousness screen. This is a **paid-enterprise selection artifact** — the 100% does not transfer to a free self-serve tool. Transferable insight: design partners are a _real-adoption_ (not vanity) tactic, and a **commitment filter screens for serious users**. ([First Round / Sierra](https://review.firstround.com/sierra-design-partnership/))
- **Build-in-public is hygiene, not a proven adoption driver. `[low]`** The directional advice (consistency over volume, ~45–60 min/day, ~1×/day) is real but vendor-blog folklore; the headline ROI anecdote ("4 months → 2,400 followers → $8K MRR") was **refuted**. Do it for relationships + demo footage, not as the growth engine.

### Refuted in round 2 — do NOT rely on

- ❌ A joinable "official MCP community" Discord at the circulated invite — doesn't exist (0-3).
- ❌ "10% self-promo rule" in r/artificial / r/webdev (0-3); r/singularity / r/AskProgramming / r/LLMDevs "outright ban self-promo" (0-3) — _unconfirmed, not validated_.
- ❌ "'I built this' framing converts 2–3×" and "OP reply within 2h converts 2–3×" (0-3) — specific multipliers unproven.
- ❌ 500–1,000-karma AutoMod gates (0-3); mandatory 80/20 ratio (0-3); "answer questions 4–6 weeks before mentioning your product" (0-3).
- ❌ Discord DAU 10–15% as a health threshold (0-3); "78% discover tools via peers / 52% dark social" (0-3).
- ❌ The 9:1 / 10:1 / "one anchor post per week" rules as _enforced moderation policy_ — vendor convention; Reddit retired its rigid ratio for "be a genuine participant."

### Still unvalidated (evidence absent, not disproven)

- The **MCP-native / Claude-native venues** the question targeted produced **no confirmed claims**: r/mcp, r/ClaudeAI, r/LocalLLaMA, r/ChatGPTCoding specifics, and the Anthropic Discord. Treat these as "participate and learn," not validated bets.
- No named **free, zero-login, cross-ecosystem** MCP/agent tool with a documented pre-launch-audience playbook.
- **Minimum-viable runway** length/content for free self-serve — unanswered with hard data.
- Whether **changelogs / public waitlists / a runway Discord** move post-launch _active use_ — unconfirmed.

### What this means for Pagent

- **Discord:** don't seed the official MCP Discord; the Cursor Discord is a real, sanctioned venue. Treat r/ClaudeAI + the Anthropic Discord as participate-and-learn.
- **Reddit:** lead with a **teardown/comparison + demo GIF**, be the first commenter with technical context, never make a Twitter link the primary link, and respect each sub's promo thread (r/SideProject is friendliest and you'll have a shipped product). Skip the folklore ratios — just genuinely participate.
- **Runway:** run a **design-partner cohort (~5–12)** while building, with a _lightweight_ commitment filter (a 20-min call / feedback cadence — the free-tool analog of Sierra's payment screen). Treat build-in-public as footage + relationships, not the growth engine. Don't bank on a waitlist.
