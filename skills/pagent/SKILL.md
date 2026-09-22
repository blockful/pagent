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

Call `write` with a title and the complete HTML document. The submitted file
is the presentation; do not convert it into Pagent slides or add a Pagent
template/navigation layer:

```json
{
  "type": "presentation",
  "title": "Acme proposal",
  "description": "September review",
  "client_label": "Acme",
  "html": "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Acme proposal</title><style>body{font-family:system-ui;padding:2rem}</style></head><body><h1>Acme proposal</h1><button id=\"details\">Show next step</button><p id=\"next\" hidden>Schedule a review.</p><script>document.getElementById('details').onclick=()=>{document.getElementById('next').hidden=false}</script></body></html>"
}
```

The result includes `page_id`, `manage_url`, and `preview_url`. To publish a
new immutable revision, call `write` again with the same presentation fields
plus that `page_id`. The exact UTF-8 HTML source is retained; the served copy
adds only invisible activity instrumentation. Retained snapshots do not yet
provide a version-history preview or restore UI; those are P1.

The viewer displays the HTML on iframe load, independently of the optional
activity bridge. Author CSP can block that bridge and prevent metrics without
hiding the document; do not promise complete engagement data for every HTML file.

Use self-contained HTML, CSS, and inline JavaScript. Author code runs in an
opaque-origin `allow-scripts` sandbox without access to Pagent cookies, storage,
or the parent DOM. Do not rely on external assets, network APIs, forms, nested
frames, popups, top navigation, `eval`, or workers. The sandbox and CSP restrict
these capabilities, and the parent frame policy blocks external navigation.
This is distinct from temporary `document` HTML, which remains sanitized and
script-free. Use `interactive` if a structured response must return to the agent.

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

For HTML presentations, report visits and active time only. Completion,
viewed-slides, furthest-slide, and last-slide metrics are null, with no slide
rollups. `contentFormat` (`html`, `slides`, or `mixed`) and `revisionNumbers`
describe the analytics scope. In mixed history, completion excludes HTML
visits and uses only known legacy slide completion; do not treat null as zero.
Existing slide revisions and legacy REST publishing remain compatible, but
the advertised `write` presentation input is HTML.

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
