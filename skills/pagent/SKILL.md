---
name: pagent
description: Show interactive UI to the user without owning a renderer. Use when text or markdown can't express what you need — a form, a confirmation, a multi-step picker, a small dashboard.
---

# Showing UI to your user

You don't have a screen, but your user does. Call `show_ui(spec)` with an A2UI v0.9 surface and the tool returns `{ page_id, url }`. **Print the URL** so the user can open it. Then call `check_result(page_id)` — it returns immediately with `{ state, result }`. If `state === "open"`, the user hasn't responded yet: wait a few seconds (or do other useful work) and call `check_result` again. When `state === "submitted"`, `result` carries the user's input as an A2UI client-action: `{ name, surfaceId, sourceComponentId, context, timestamp }`. The renderer detects that you've fetched the result (state flips to `"received"` on your first read) and shows "the agent has your input" feedback to the user. Each page is **single-shot**: one spec, one result. For a follow-up question, call `show_ui` again with a fresh spec — there is no surface-replace mechanism.

The `spec` is an array of A2UI v0.9 messages: one `createSurface`, then `updateComponents` with a tree whose root component MUST have id `"root"`. The basic catalog (`https://a2ui.org/specification/v0_9/basic_catalog.json`) gives you `Column`, `Row`, `Card`, `Text`, `TextField`, `Button`, `Checkbox`, `Image`, `Divider`, `List`, `Tabs`, `Slider`, etc. Buttons fire actions via `action: { event: { name: "your_event", context: { ... } } }` — that `name` is what arrives in the `result.name` field. Bind input fields with `value: { path: "/some/key" }` and reference those paths in the button's context (e.g. `{ "name": { "path": "/some/key" } }`) so user input flows back to you. Keep specs small — one screen, one purpose. If `check_result` returns 404 / "Page not found", the page expired (default TTL 30 min) — start a new one with `show_ui`.

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

## Polling cadence

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

## Setup expectation

These tools talk to the hosted `pagent` REST service at `https://pagent.up.railway.app` by default. Set the `PAGENT_URL` env var to point at a self-hosted instance (e.g. `http://localhost:8787` if you're running the repo locally).
