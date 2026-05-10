# Releasing Pagent

Runbook for cutting a versioned release. Read top-to-bottom the first time; use individual sections as a checklist on repeat releases.

---

## Versioning policy

Pagent uses **semver** (`MAJOR.MINOR.PATCH`):

| Bump  | When                                                                                          |
| ----- | --------------------------------------------------------------------------------------------- |
| MAJOR | A breaking API change — e.g. removing or renaming an endpoint.                                |
| MINOR | Backward-compatible additions: new MCP tools, new optional API fields, new optional env-vars. |
| PATCH | Bugfixes, dependency updates, doc-only changes.                                               |

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

### 2. CI gate

Confirm the GitHub Actions CI workflow is green on the PR targeting `main`.

### 3. Bump versions — five files, all must agree

There is no automated version-bump script. Edit each file manually (or with `sed -i`):

| File                         | Field       |
| ---------------------------- | ----------- |
| `package.json` (root)        | `"version"` |
| `apps/api/package.json`      | `"version"` |
| `apps/web/package.json`      | `"version"` |
| `apps/mcp/package.json`      | `"version"` |
| `.claude-plugin/plugin.json` | `"version"` |

Quick one-liner (replace `X.Y.Z`):

```bash
NEW=X.Y.Z
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW\"/" \
  package.json \
  apps/api/package.json \
  apps/web/package.json \
  apps/mcp/package.json \
  .claude-plugin/plugin.json
```

Verify with `grep -r '"version"' package.json apps/*/package.json .claude-plugin/plugin.json` — all five should show the same string.

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
        .claude-plugin/plugin.json
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

Use the release notes body to document user-facing changes (new tools, env-vars, API additions, breaking changes). Keep a "Breaking changes" section at the top if `MAJOR` bumped.

---

## Hotfix flow

When a bug on `main` needs a patch release without pulling in unfinished feature work:

1. Branch from the affected tag:
   ```bash
   git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z
   ```
2. Fix the bug.
3. Bump the PATCH version across all five files (same as step 3 above).
4. Rebuild the MCP bundle (`npm run build:mcp`).
5. Run the full local gate (step 1 above).
6. Commit as `chore(release): vX.Y.Z+1`, push the hotfix branch, open a PR.
7. After merging to `main`, tag and create the GitHub Release as usual.
8. Cherry-pick or re-integrate onto any other long-lived branches to prevent divergence.

---

## Rollback

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
- Confirm Railway auto-deployed from `main`: `curl https://pagent.up.railway.app/health`.
- Confirm Vercel auto-deployed from `main`: open `https://pagent.vercel.app` and check the page loads.
- If the Railway or Vercel deploys did not trigger automatically, redeploy manually from their dashboards.
