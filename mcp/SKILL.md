---
name: agent-ui-session
description: Show interactive UI to the user without owning a renderer. Use when you need the user to fill a form, pick from options, or see a rich result.
---

# Showing UI to your user

You don't have a screen, but your user does. When text or markdown isn't enough — a form, a list of choices, a confirmation, a small dashboard — call `show_ui` with an A2UI v0.9 surface. The tool returns `{ session_id, url }`. Print the URL. Your user clicks it and the UI opens in their browser. Then call `wait_for_event(session_id)` to receive their input. `wait_for_event` long-polls for up to 25 seconds and returns the next user action (or null on timeout — call again to keep waiting). Surfaces can be replaced mid-conversation by calling `show_ui` again with the same shape, so you can build multi-turn UI.

The `spec` is an array of A2UI v0.9 messages: `createSurface` once, then `updateComponents` with a tree of components whose root MUST have id `"root"`. The basic catalog at `https://a2ui.org/specification/v0_9/basic_catalog.json` gives you `Column`, `Row`, `Card`, `Text`, `TextField`, `Button`, `Checkbox`, `Image`, etc. Buttons fire actions via `action: { event: { name: "your_action_name", context: {...} } }` — that name is what you'll see in `wait_for_event`'s response. For input fields, bind values with `value: { path: "/some/path" }` and the user's input lands at that path in the surface's data model; you can read it from the action's `context` if you wire it explicitly, or post a follow-up surface that reflects the new state. Keep specs small — one screen, one purpose.
