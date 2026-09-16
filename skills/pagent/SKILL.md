---
name: pagent
description: Use Pagent's two MCP tools to write browser pages and read interactive responses or durable presentation analytics. Trigger for forms, pickers, confirmations, reports, dashboards, visual documents, slides, proposals, controlled sharing, and engagement analysis.
---

# Pagent pages

Pagent exposes exactly two tools:

- `write` creates or revises a page.
- `read` retrieves the useful output of a page.

Always give the returned URL to the user. Never invent a third management tool.
Sharing, permissions, and workspace administration happen in the authenticated
Pagent web app.

## Choose a page type

| Type           | Use it for                                                                              | Lifecycle                  | What to read              |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------- | ------------------------- |
| `interactive`  | Forms, choices, confirmations, and any structured answer                                | Temporary, single response | Response state and action |
| `document`     | Reports, dashboards, charts, comparisons, and other view-only layouts                   | Temporary                  | Nothing; it is view-only  |
| `presentation` | Proposals, slide decks, and material that needs durable sharing and engagement analysis | Durable and revisioned     | Authorized analytics      |

Temporary pages may work without a token only while the service's anonymous
grace mode is enabled. Durable presentation pages and all analytics require an
authenticated Pagent identity.

## Write a page

### Interactive

Call `write` with:

```json
{
  "type": "interactive",
  "spec": [
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
          {
            "id": "root",
            "component": "Column",
            "children": ["title", "field", "submit"]
          },
          { "id": "title", "component": "Text", "text": "What's your name?" },
          {
            "id": "field",
            "component": "TextField",
            "label": "Name",
            "value": { "path": "/name" }
          },
          { "id": "submit-label", "component": "Text", "text": "Submit" },
          {
            "id": "submit",
            "component": "Button",
            "child": "submit-label",
            "variant": "primary",
            "action": {
              "event": {
                "name": "submitted",
                "context": { "name": { "path": "/name" } }
              }
            }
          }
        ]
      }
    }
  ]
}
```

An A2UI v0.9 surface starts with `createSurface`, then
`updateComponents`. The root component ID must be `root`. Component names are
case-sensitive. Bind input values to paths and reference those paths in a
button event's context so the final action contains the response.

Keep each page to one clear task. For a follow-up question, write a new page.

### Document

Call `write` with view-only HTML:

```json
{
  "type": "document",
  "html": "<main><h1>Release report</h1><p>All checks passed.</p></main>"
}
```

HTML is sanitized and rendered without scripts, event handlers, or form
submission. Use `interactive` when a user must send anything back.

### Presentation

Call `write` with stable slide IDs and explicit slide boundaries:

```json
{
  "type": "presentation",
  "title": "Acme proposal",
  "description": "September review",
  "client_label": "Acme",
  "slides": [
    { "id": "intro", "title": "Introduction", "html": "<h1>Acme</h1>" },
    { "id": "plan", "title": "Plan", "html": "<h2>Next steps</h2>" }
  ]
}
```

The result includes `page_id`, `manage_url`, and `preview_url`. To publish a
new immutable revision, call `write` again with the same presentation fields
plus that `page_id`. Keep slide IDs stable across revisions when the logical
slide is unchanged; analytics use them to preserve meaning.

Presentation creation does not implicitly create or configure a share link.
Open `manage_url` to set Anyone, Allowed email, or Authenticated viewer access.

## Read a page

Call `read` with the `page_id` returned by `write`:

```json
{ "page_id": "..." }
```

Pagent infers the sensible output from the ID. Use `include` only when being
explicit:

- `{ "page_id": "...", "include": "response" }` for a temporary interactive page.
- `{ "page_id": "...", "include": "analytics" }` for a durable presentation page.

`read` never waits. An interactive page returns `state: "open"` and a null
response until the user submits. Poll at roughly 2, 4, 8, 15, then 30-second
intervals, cap the wait at `expires_at`, and do useful work between reads. The
first read after submission returns `submitted`; later reads return `received`.
Do not poll a document page.

If a temporary page is missing or expired, write a new page instead of retrying
the same ID forever. Presentation analytics require authentication and the
owner, sender, or an explicitly granted workspace permission.

## Access and identity

- **Anyone** may open the share link; analytics label unknown viewers Anonymous.
- **Allowed email** accepts a matching entered address without inbox proof;
  analytics must label that identity Unverified.
- **Authenticated viewer** requires the viewer to prove an allowed identity.

Email-only access is convenience gating, not authentication. Recommend
Authenticated viewer for confidential content.

## Breaking tool migration

The former tool names have no aliases. Use `write` for all page creation and
`read` for responses or analytics. If an MCP client still advertises older
names, restart it so it refreshes the server's tool list.

## Service configuration

The bundled stdio server uses `https://api.pagent.link` by default. Set
`PAGENT_URL` to use another deployment. Set `PAGENT_TOKEN` for durable pages,
analytics, or any deployment with authentication enforcement enabled.
