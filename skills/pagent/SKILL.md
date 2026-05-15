---
name: pagent
description: Render UI in the user's browser. Two tools — show_ui for asking the user a question that needs a structured answer back (forms, pickers, confirmations, dashboards-as-input, multi-step wizards), and show_html for showing a rich visualization the user just looks at (reports, dashboards, charts, infographics, comparison tables, slides). Trigger on "show me", "ask me", "let me pick", "confirm before you", "give me a dashboard", "render a chart", "show a report" — anything that beats plain text in chat. Rule: if anything has to come back from the user, show_ui. If the user just looks, show_html.
---

# Showing UI to your user

## Picking a tool

Two tools, one rule: **`show_html` to show; `show_ui` to ask.**

If anything has to come back from the user — a value, a selection, a click — use `show_ui`. If the user just looks at it — a report, a chart, a dashboard, a comparison — use `show_html`. When in doubt, ask yourself: "Do I need to read the user's response?" Yes → `show_ui`. No → `show_html`.

Multi-step flows work the same way: each step is a separate page. Show a dashboard with `show_html`, then ask "what next?" with `show_ui`. Don't try to bundle visualization and input into one page.

Only A2UI pages (created by `show_ui`) have a result. HTML pages (`show_html`) never transition out of `open` — do not poll `check_result` on them.

## When to use show_ui

Reach for `show_ui` whenever a real input widget would beat asking the user to type freeform answers in chat. Examples that should trigger it:

- "Ask me my favorite color via a UI form."
- "Let me pick from the top 5 candidates you found."
- "Confirm before you delete those files — show me a real button, not a yes/no in chat."
- "Build me a quick dashboard of the test results."
- "Walk me through this setup as a multi-step wizard."
- "Give me a slider so I can tune the threshold and see the count update."

Indirect cues count too: "let me choose", "let me approve", "show me", "give me a form", "make me pick", or any time the next step needs structured input (numbers, dates, multi-select, file paths) rather than a sentence.

Examples where this skill should NOT trigger — keep these as plain text/markdown:

- "Show me a markdown table of these results." (rendering, not input — use `show_html` if it deserves a real layout)
- "Summarize the diff." (no user input expected)
- "What's the capital of France?" (one-shot factual, no choice to make)

Rule of thumb: if the next message you'd send the user contains a question they need to answer, prefer `show_ui` over asking in chat — unless the answer is one short sentence.

## How show_ui works

You don't have a screen, but your user does. Call `show_ui(spec)` with an A2UI v0.9 surface and the tool returns `{ page_id, url }`. **Print the URL** so the user can open it. Then call `check_result(page_id)` — it returns immediately with `{ state, result }`. If `state === "open"`, the user hasn't responded yet: wait a few seconds (or do other useful work) and call `check_result` again. When `state === "submitted"`, `result` carries the user's input as an A2UI client-action: `{ name, surfaceId, sourceComponentId, context, timestamp }`. The renderer detects that you've fetched the result (state flips to `"received"` on your first read) and shows "the agent has your input" feedback to the user. Each page is **single-shot**: one spec, one result. For a follow-up question, call `show_ui` again with a fresh spec — there is no surface-replace mechanism.

The `spec` is an array of A2UI v0.9 messages: one `createSurface`, then `updateComponents` with a tree whose root component MUST have id `"root"`. The basic catalog (`https://a2ui.org/specification/v0_9/basic_catalog.json`) gives you `Column`, `Row`, `Card`, `Text`, `TextField`, `Button`, `Checkbox`, `Image`, `Divider`, `List`, `Tabs`, `Slider`, etc. Buttons fire actions via `action: { event: { name: "your_event", context: { ... } } }` — that `name` is what arrives in the `result.name` field. Bind input fields with `value: { path: "/some/key" }` and reference those paths in the button's context (e.g. `{ "name": { "path": "/some/key" } }`) so user input flows back to you. Keep specs small — one screen, one purpose. If `check_result` throws "Page not found", the page expired (default TTL 30 min) — start a new one with `show_ui`.

## Worked example: "What's your name?"

```json
[
  {
    "createSurface": {
      "surfaceId": "main",
      "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json"
    }
  },
  {
    "updateComponents": {
      "surfaceId": "main",
      "components": [
        { "id": "root", "component": "Column", "children": ["title", "field", "submit"] },
        { "id": "title", "component": "Text", "text": "What's your name?" },
        { "id": "field", "component": "TextField", "label": "Name", "value": { "path": "/name" } },
        { "id": "submit-label", "component": "Text", "text": "Submit" },
        {
          "id": "submit",
          "component": "Button",
          "child": "submit-label",
          "variant": "primary",
          "action": { "event": { "name": "submitted", "context": { "name": { "path": "/name" } } } }
        }
      ]
    }
  }
]
```

Call pattern:

1. `show_ui(spec)` → `{ page_id: "abc...", url: "http://localhost:8788/abc..." }`. Print the URL.
2. `check_result("abc...")` → `{ "state": "open", "result": null }`. User hasn't clicked yet.
3. Wait a few seconds, do other work, then call again.
4. `check_result("abc...")` → after the user types `Alex` and clicks Submit:

```json
{
  "state": "submitted",
  "result": {
    "name": "submitted",
    "surfaceId": "main",
    "sourceComponentId": "submit",
    "context": { "name": "Alex" },
    "timestamp": "..."
  }
}
```

That first read flips the page to `received`; the renderer picks that up and tells the user the agent has their input.

## Polling cadence (show_ui only)

Polling is your call — the service does no waiting on your behalf — so
spend that latitude wisely. A reasonable shape:

- **Start at 2-3 seconds.** Most users submit fast on simple forms;
  responsiveness matters more than load.
- **Back off exponentially up to ~30 seconds.** Doubles each miss:
  `2 → 4 → 8 → 16 → 30 → 30 → 30 …`. Each call is a cheap GET; the
  ceiling keeps load bounded for users who walk away.
- **Cap total wait at the page's TTL** (default 30 minutes — see the
  `expires_at` returned by `show_ui`). Beyond TTL the page is gone
  and `check_result` will throw "Page not found".
- **Do other useful work in between calls.** The polling pattern is
  meant to be cooperative — read context, summarize prior steps,
  prepare follow-up plans. Don't sleep blocking the conversation.

When `check_result` throws "Page not found" — either the user closed
the tab without submitting and the TTL elapsed, or some upstream
issue evicted the page. **Don't retry the same `page_id`.** Decide:
ask the user (in chat) whether they still want the form, and if so
call `show_ui` again with a fresh spec. Don't loop forever assuming
they'll come back.

When `check_result` returns `state: "received"`, the user previously
submitted AND you've already read the result on a prior poll. Treat
this as "already handled" — usually means a duplicate poll snuck in.

Reminder: do **not** poll `check_result` on pages created with `show_html`
— HTML pages stay `open` forever and have no result.

## When to use show_html

Reach for `show_html` whenever you want to show the user something rich and visual that text in chat can't do justice to:

- "Show me a styled dashboard of the test results."
- "Render the last quarter's metrics as an infographic."
- "Build me a side-by-side comparison table of these three options, with logos."
- "Give me a one-page report on the open issues, grouped by severity."
- "Mock up a landing page for this idea."
- "Show me a chart of the response times."

Indirect cues: "show me", "render", "make me a", "design a", "lay this out as".

NOT for input: if the next message you'd send the user contains a question they need to answer, use `show_ui` instead.

## How show_html works

Call `show_html(html)` with a single string containing the page body. The string can be a full document (`<!doctype html>…`) or a fragment (`<div>…</div>`) — the renderer wraps it in a sandboxed scaffold either way. The tool returns `{ page_id, url }`. **Print the URL** so the user can open it. Do NOT poll `check_result` on this page — HTML is one-way.

Rules (enforced — violations are stripped or rejected server-side):

- **No JavaScript.** `<script>` tags are stripped. `onclick=`, `onload=`, all `on*=` event handlers are stripped. `javascript:` URLs are stripped.
- **No external assets.** Inline all CSS as `<style>`. Embed images as `data:image/...;base64,...` URIs. No Google Fonts, no CDN scripts, no remote `<img src=https:>`.
- **No forms.** `<form action=…>` submissions are blocked by CSP. Use `show_ui` if you need input.
- **No `<iframe>`, `<meta http-equiv=refresh>`, `<object>`, `<embed>`.** Stripped.
- **1 MB payload cap.** Watch data-URI sizes.

The result: a maximally locked-down sandboxed iframe runs your HTML inside the user's browser. The user views it. Nothing comes back.

## Worked example: a styled report

```python
html = """
<style>
  body { font-family: -apple-system, sans-serif; padding: 32px; max-width: 720px; margin: 0 auto; color: #1b1b1b; }
  h1 { color: #5154b3; }
  .stat { display: inline-block; padding: 16px; margin-right: 12px; background: #f5f5f7; border-radius: 8px; }
  .stat-value { font-size: 32px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #777; text-transform: uppercase; }
</style>
<h1>Q3 Engineering Report</h1>
<div class="stat"><div class="stat-value">142</div><div class="stat-label">PRs merged</div></div>
<div class="stat"><div class="stat-value">11</div><div class="stat-label">Bugs closed</div></div>
<div class="stat"><div class="stat-value">3</div><div class="stat-label">Outages</div></div>
<p>The team shipped 142 pull requests this quarter…</p>
"""
show_html(html)
```

Print the returned URL. Move on — no polling.

## Setup expectation

These tools talk to the hosted `pagent` REST service at `https://pagent.up.railway.app` by default. Set the `PAGENT_URL` env var to point at a self-hosted instance (e.g. `http://localhost:8787` if you're running the repo locally).
