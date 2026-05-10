---
name: agent-ui-session
description: Show interactive UI to the user without owning a renderer. Use when text or markdown can't express what you need — a form, a confirmation, a multi-step picker, a small dashboard.
---

# Showing UI to your user

You don't have a screen, but your user does. Call `show_ui(spec)` with an A2UI v0.9 surface and the tool returns `{ session_id, url }`. **Print the URL** so the user can open it. Then call `wait_for_event(session_id)` to receive their input — it long-polls for up to 25 s and resolves to either `{ event: { type: "user_action", action: { name, surfaceId, sourceComponentId, context, timestamp } } }` or `{ event: null }` (idle timeout — call again to keep waiting). You can replace the surface mid-conversation by calling `show_ui` again, so multi-turn flows are natural: render → wait → read → re-render. If `wait_for_event` errors with "Session not found", the session expired (default TTL 30 min) — start a new one with `show_ui`.

The `spec` is an array of A2UI v0.9 messages: one `createSurface`, then `updateComponents` with a tree whose root component MUST have id `"root"`. The basic catalog (`https://a2ui.org/specification/v0_9/basic_catalog.json`) gives you `Column`, `Row`, `Card`, `Text`, `TextField`, `Button`, `Checkbox`, `Image`, `Divider`, `List`, `Tabs`, `Slider`, etc. Buttons fire actions via `action: { event: { name: "your_event", context: { ... } } }` — that `name` is what arrives in `wait_for_event`'s response. Bind input fields with `value: { path: "/some/key" }` and reference those paths in the button's context (e.g. `{ "name": { "path": "/some/key" } }`) so user input flows back to you. Keep specs small — one screen, one purpose. Once you've handled the input, render a confirmation surface or close the loop in plain text.

## Minimal example

```json
[
  { "createSurface": { "surfaceId": "main", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
  { "updateComponents": { "surfaceId": "main", "components": [
    { "id": "root", "component": "Column", "children": ["title", "field", "submit"] },
    { "id": "title", "component": "Text", "text": "What's your name?" },
    { "id": "field", "component": "TextField", "label": "Name", "value": { "path": "/name" } },
    { "id": "submit-label", "component": "Text", "text": "Submit" },
    { "id": "submit", "component": "Button", "child": "submit-label", "variant": "primary",
      "action": { "event": { "name": "submitted", "context": { "name": { "path": "/name" } } } } }
  ] } }
]
```

After the user types `Alex` and clicks Submit, `wait_for_event` returns:

```json
{
  "event": {
    "type": "user_action",
    "action": { "name": "submitted", "surfaceId": "main", "sourceComponentId": "submit",
                "context": { "name": "Alex" }, "timestamp": "..." }
  }
}
```

## Setup expectation

These tools require an `agent-ui-session` REST service to be reachable (default `http://localhost:8787`; override with the `AGENT_UI_SESSION_URL` env var). If `show_ui` errors with a connection refused, the service isn't running — start it with `npm run dev` from the project repo, or point at a deployed instance.
