# Vendored packages

This directory contains vendored copies of two packages from the
[A2UI](https://github.com/google/A2UI) project.

## Why vendored?

`apps/web` previously declared these deps as sibling-repo `file:` paths:

```
"@a2ui/lit":      "file:../../../a2ui/renderers/lit"
"@a2ui/web_core": "file:../../../a2ui/renderers/web_core"
```

That only worked by accident when the `gen-ui-sf/a2ui/` repository happened
to be checked out next to this one. It broke in git worktrees, forks, and
fresh clones. Vendoring removes the external dependency entirely and makes
the worktree self-sufficient.

## Contents

| Directory        | Package         | Version | License        |
|------------------|-----------------|---------|----------------|
| `a2ui-lit/`      | `@a2ui/lit`     | 0.9.3   | Apache-2.0 (Google) |
| `a2ui-web-core/` | `@a2ui/web_core`| 0.9.2   | Apache-2.0 (Google) |

Upstream source: <https://github.com/google/A2UI>
- `renderers/lit` — Lit-based renderer
- `renderers/web_core` — Web core renderer

Each directory contains only the runtime artifacts (`dist/`, `package.json`,
`README.md`, `CHANGELOG.md`, `LICENSE`). Source code, `node_modules/`,
lock files, and tooling are intentionally excluded.

## How to refresh

When you need to update to a newer upstream release:

1. Clone (or fetch) upstream at the desired tag:
   ```
   git clone --depth 1 --branch <tag> https://github.com/google/A2UI /tmp/a2ui
   ```
2. Copy the runtime artifacts over the existing vendor directories:
   ```
   cp -r /tmp/a2ui/renderers/lit/dist          apps/web/vendor/a2ui-lit/
   cp    /tmp/a2ui/renderers/lit/package.json  apps/web/vendor/a2ui-lit/
   cp    /tmp/a2ui/renderers/lit/README.md     apps/web/vendor/a2ui-lit/
   cp    /tmp/a2ui/renderers/lit/CHANGELOG.md  apps/web/vendor/a2ui-lit/
   cp    /tmp/a2ui/LICENSE                     apps/web/vendor/a2ui-lit/

   cp -r /tmp/a2ui/renderers/web_core/dist          apps/web/vendor/a2ui-web-core/
   cp    /tmp/a2ui/renderers/web_core/package.json  apps/web/vendor/a2ui-web-core/
   cp    /tmp/a2ui/renderers/web_core/README.md     apps/web/vendor/a2ui-web-core/
   cp    /tmp/a2ui/renderers/web_core/CHANGELOG.md  apps/web/vendor/a2ui-web-core/
   cp    /tmp/a2ui/LICENSE                          apps/web/vendor/a2ui-web-core/
   ```
3. Run `npm install` from the repo root to update `package-lock.json`.
4. Run `npm run build:web` to verify the build succeeds.
5. Commit, including the upstream commit SHA in the message, e.g.:
   ```
   chore(web): bump @a2ui/lit to <version> (upstream <sha>)
   ```
