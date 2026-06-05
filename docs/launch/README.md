# Pagent — Launch Playbook

> Working set of launch docs. Created 2026-06-04. Owner: @alextnetto.

This folder holds everything needed to take Pagent from "built and deployed" to "launched and adopted." It is the output of a current-state audit + a deep-research pass on how agent/MCP/dev tools actually got adopted in 2025–2026.

## The four documents

| # | Doc | What it is |
|---|-----|-----------|
| 01 | [Current-state audit](./01-current-state-audit.md) | Honest read of where Pagent is today: live product, copy, usage, security, v2 |
| 02 | [Copy & app change list](./02-copy-and-app-change-list.md) | Prioritized (P0/P1/P2) fixes to the app and copy, with proposed text |
| 03 | [Research: agent-tool launches](./03-research-agent-tool-launches.md) | Adversarially-verified findings on what drove adoption for MCP/agent/dev tools |
| 04 | [GTM / launch plan](./04-gtm-launch-plan.md) | The campaign: positioning, north-star metric, runway phases, channel playbooks |

## Headline decisions (set 2026-06-04)

- **Scope:** build the **full v2** (auth + 6 features), *then* launch. Multi-week runway.
- **Audience:** the **whole MCP/agent ecosystem** ("works in any MCP client"), with Claude Code as the highest-density beachhead within that.
- **North-star metric:** **adoption** = active renders (`show_ui`/`show_html` calls), not stars/upvotes/signups.
- **Channels:** Product Hunt, X (demo-led), Reddit/Discord seeding, + test Show HN and MCP-registry distribution.

## Recommended execution order (all doable during the v2 build)

1. **P0 copy + OG image** ([doc 02](./02-copy-and-app-change-list.md)) — every launch channel is a shared link.
2. **Instrument the north-star funnel** in Grafana (install → first render → repeat).
3. **Demo video + always-on demo page** — the demo *is* the pitch for this category.
4. **Publish to the official MCP Registry** + claim aggregator listings (table-stakes visibility).
5. **Build-in-public + design-partner beta** during late build.
6. **Launch moment:** Show HN → Product Hunt → X thread → Reddit/Discord, founder present all day.

## Status

- ✅ Audit, copy list, GTM plan — complete.
- ✅ Research round 1 (launch playbooks, channels, registries) — complete.
- ✅ Research round 2 (Reddit/Discord seeding + pre-launch runway) — complete; folded into [doc 03](./03-research-agent-tool-launches.md) and [doc 04](./04-gtm-launch-plan.md).
