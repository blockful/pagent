# 06 — Frontend routing and Vite dev-proxy for custom URLs

## Description

Update the web renderer to parse `/:handle/:slug` paths, resolve them to page IDs via the new API endpoint, and add Vite dev-server proxy rules so custom URL paths work in local development.

## Files to create/modify

- `apps/web/main.ts` — replace the single-segment `pageId` extraction with `parseRoute(pathname)` returning a `PageRef` discriminated union (`{ kind: 'id'; id } | { kind: 'handle-slug'; handle; slug } | { kind: 'home' } | { kind: 'showcase' }`); add resolution fetch in `AgentUIApp` that calls `GET ${API_BASE}/resolve/${handle}/${slug}` for `handle-slug` routes, extracts the `id`, then continues with existing page-load logic; show "Page not found" on 404 from resolve
- `apps/web/vite.config.ts` — add proxy rule for `/resolve/:handle/:slug` (always API); add content-negotiated proxy rule for `/:handle/:slug` patterns (HTML requests get SPA shell, fetch requests proxied to API)

## Acceptance criteria

- Navigating to `http://localhost:8788/alex/quarterly-review` renders the page (after resolution)
- Navigating to `http://localhost:8788/<32-char-hex>` works exactly as before
- Navigating to `http://localhost:8788/` shows the home page
- Navigating to `http://localhost:8788/_components` shows the component showcase
- Resolution failure (404 from API) shows a "Page not found or expired" message
- `parseRoute()` prioritizes hex IDs over handle/slug (a 32-char hex string is always treated as an ID)
- Vite dev proxy correctly routes `/resolve/...` requests to the API server
- Vite dev proxy correctly content-negotiates `/:handle/:slug` requests (HTML -> SPA, fetch -> API)
- No changes needed to Vercel rewrite config (existing catch-all handles it)
- Browser URL bar keeps the custom URL (no rewrite to hex ID)

## Dependencies

- 04 (resolve endpoint must exist for the frontend to call)

## Relevant spec sections

- 5.1 Routing logic and precedence
- 5.3 Redirect behavior
- 6.1 Current routing (main.ts)
- 6.2 Updated routing
- 6.3 Resolution in AgentUIApp
- 6.4 Vite dev-server proxy changes
- 6.5 Vercel rewrite (no change needed)
