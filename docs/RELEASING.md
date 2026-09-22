# Releasing Pagent

Runbook for cutting a versioned release. Read top-to-bottom the first time; use individual sections as a checklist on repeat releases.

---

## Versioning policy

Pagent uses **semver** (`MAJOR.MINOR.PATCH`):

| Bump  | When                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------- |
| MAJOR | A breaking API change — e.g. removing or renaming an endpoint.                                          |
| MINOR | Backward-compatible additions within `write`/`read`, new optional API fields, or new optional env-vars. |
| PATCH | Bugfixes, dependency updates, doc-only changes.                                                         |

**Marketplace tracking caveat.** The Claude Code plugin marketplace currently resolves `pagent@pagent` to `main` HEAD, not to a tag. Tags create immutable historical pointers useful for `git checkout`, hotfix branching, and GitHub Release notes, but they do not automatically become the install target. Users who want to pin to a specific release can clone the repo and point Claude Code at a local checkout (`claude --plugin-dir /path/to/pagent`); most users will continue tracking `main`. This is a known limitation to revisit once the marketplace supports version-pinned installs.

---

## Pre-release checklist

Work on a feature or hotfix branch. Before opening the PR to `main`:

### 1. Local gate — all must be green

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build:web
npm run build:mcp
```

Or run the Husky hook directly: `.husky/pre-push` (covers the first four steps).

For releases that change page behavior, also verify the production-equivalent
stories rather than relying on a successful build alone:

- Both MCP transports list exactly `write` and `read`.
- Grace mode permits only temporary anonymous pages; durable writes and
  analytics reads reject unauthenticated callers.
- An authenticated presentation can be revised, shared, viewed, and read for
  analytics.
- Publish a complete HTML document through the rebuilt stdio MCP bundle. Verify
  its own JavaScript in owner preview and a shared link, no preview visits, and
  page-level analytics with unavailable slide/completion metrics. Set exact
  `ALLOWED_ORIGINS` for the renderer in every environment, including local QA.
- For legacy structured decks, read slide 1, advance to slide 2, then return to slide 1. Check that time
  remains attributed to the slide actually read, sequence is `1 → 2 → 1`, and
  last slide/drop-off is 1 without increasing distinct-slide completion.
- Backgrounding and sixty-second inactivity pause active time. Returning in
  the same tab after thirty minutes starts a new visit.
- `/admin` enforces workspace-admin access and does not reveal private page
  content or viewer-level analytics without an explicit grant.

The analytics qualification migration is additive and runs at API startup.
Historical raw events did not retain the one-second qualification result, so
their exact appearance order cannot be reconstructed reliably. Such visits
return `sequenceComplete: false`, an empty sequence, and no asserted last slide
or exit; the UI labels their sequence as unrecorded. Existing slide totals,
distinct completion, and immutable revision history remain intact. Do not
backfill guessed order or claim previously misattributed dwell was repaired.

### 2. CI gate

Confirm the GitHub Actions CI workflow is green on the PR targeting `main`.

### 3. Bump versions — six files, all must agree

There is no automated version-bump script. Edit each file manually (or with `sed -i`):

| File                         | Field          |
| ---------------------------- | -------------- |
| `package.json` (root)        | `"version"`    |
| `apps/api/package.json`      | `"version"`    |
| `apps/web/package.json`      | `"version"`    |
| `apps/mcp/package.json`      | `"version"`    |
| `.claude-plugin/plugin.json` | `"version"`    |
| `docs/openapi.yaml`          | `info.version` |

Quick one-liner for the JSON/plugin files (replace `X.Y.Z`):

```bash
NEW=X.Y.Z
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW\"/" \
  package.json \
  apps/api/package.json \
  apps/web/package.json \
  apps/mcp/package.json \
  .claude-plugin/plugin.json
# Also update the OpenAPI spec:
sed -i '' "s/^  version: .*/  version: $NEW/" docs/openapi.yaml
```

Verify with `grep -r '"version"' package.json apps/*/package.json .claude-plugin/plugin.json` — all five JSON files should show the same string; then check `grep 'version:' docs/openapi.yaml` matches too.

> Note: `npm version --workspaces` does not reliably propagate to `private: true` workspaces in all npm versions, and it does not touch `.claude-plugin/plugin.json` at all. Manual editing is the canonical path.

### 4. Rebuild the MCP bundle

```bash
npm run build:mcp
```

Commit the regenerated `apps/mcp/server.bundle.js` alongside the version bumps. CI verifies the bundle is up-to-date; a stale bundle will fail the gate.

### 5. Commit the version bumps

```bash
git add package.json apps/api/package.json apps/web/package.json \
        apps/mcp/package.json apps/mcp/server.bundle.js \
        .claude-plugin/plugin.json docs/openapi.yaml
git commit -m "chore(release): vX.Y.Z"
```

Merge the PR to `main` via normal review flow.

---

## Tagging and pushing

After the version-bump commit lands on `main`:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Create the GitHub Release from the tag — this is the de-facto changelog until a `CHANGELOG.md` exists:

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "Summarise what changed. Reference PRs and issues."
```

Use the release notes body to document user-facing changes (new page types,
env-vars, API additions, breaking changes). Keep a "Breaking changes" section
at the top if `MAJOR` bumped.

Pagent's MCP surface is fixed at exactly `write` and `read`. A new page type or
read capability extends one of those schemas; it does not add another public
tool. Renaming or removing either tool is a breaking change.

---

## Hotfix flow

When a bug on `main` needs a patch release without pulling in unfinished feature work:

1. Branch from the affected tag:
   ```bash
   git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z
   ```
2. Fix the bug.
3. Bump the PATCH version across all six files (same as step 3 above).
4. Rebuild the MCP bundle (`npm run build:mcp`).
5. Run the full local gate (step 1 above).
6. Commit as `chore(release): vX.Y.Z+1`, push the hotfix branch, open a PR.
7. After merging to `main`, tag and create the GitHub Release as usual.
8. Cherry-pick or re-integrate onto any other long-lived branches to prevent divergence.

---

## Rollback

**Database compatibility comes first.** After migration 4 has run, do not deploy
the pre-HTML API (`b93e330` or earlier) or blindly revert the HTML feature. The
migrator rejects unknown applied versions, and old readers cannot render HTML
revisions. Prefer a forward fix. If reverting application changes, retain migration
4's registration and the HTML storage/read compatibility, rebuild the MCP bundle,
and test against a migrated database containing both legacy and HTML revisions.
Never delete migration ledger rows, the HTML column, or saved revisions to make
an older binary start. Keep API, renderer, and MCP contracts compatible together.

The plugin marketplace install tracks `main`. There is no per-install version pinning today. Rolling back a bad release means:

1. Revert the bad commit on `main`:
   ```bash
   git revert <bad-commit-sha>
   git push origin main
   ```
2. Rebuild the MCP bundle if `apps/mcp/server.ts` was part of the bad commit:
   ```bash
   npm run build:mcp
   git add apps/mcp/server.bundle.js
   git commit -m "fix: rebuild MCP bundle after revert"
   git push origin main
   ```
3. Confirm Railway and Vercel auto-deployed the reverted `main` and `/health` returns 200.

Users who already installed the plugin will pick up the reverted `main` on their next Claude Code session restart (the MCP server process is re-spawned). There is no push mechanism to active sessions.

---

## Post-release

- Update `README.md` quickstart if any new commands or env-vars shipped.
- Confirm Railway auto-deployed from `main`: `curl https://api.pagent.link/health`.
- Confirm Vercel auto-deployed from `main`: open `https://pagent.link` and check the page loads.
- If the Railway or Vercel deploys did not trigger automatically, redeploy manually from their dashboards.
