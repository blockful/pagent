# Contributing to pagent

Thanks for considering a contribution. Pagent is a small project; PRs are
reviewed by [@netto-](https://github.com/netto-). Here is what you need to
know before opening one.

---

## Setup

```bash
git clone git@github.com:blockful/pagent.git
cd pagent
npm install   # workspace install for all three apps
npm run dev   # API on :8787, renderer on :8788
```

**Requirements:**

- Node 22+ (`engines.node` in `package.json` enforces this).
- The MCP bundle (`apps/mcp/server.bundle.js`) is pre-committed. You only
  need to rebuild it if you edit `apps/mcp/server.ts`:
  ```bash
  npm run build:mcp
  ```
- For local-with-Claude-Code testing:
  ```bash
  claude --plugin-dir /absolute/path/to/pagent
  PAGENT_URL=http://localhost:8787 claude
  ```

---

## Project layout

```
apps/api/        REST service (Hono). Deployed on Railway.
apps/web/        Vite renderer. Deployed on Vercel.
apps/mcp/        stdio MCP server: show_ui + check_result.
skills/pagent/   Drop-in skill teaching the polling pattern.
.claude-plugin/  Claude Code plugin manifest + marketplace entry.
.mcp.json        Plugin's MCP server registration.
```

The repo doubles as a Claude Code plugin. The `skills/` directory lives at the
root because the plugin loader expects it next to `.claude-plugin/`.

---

## Branches and PRs

- Branch from `main`; name it `kind/short-description`
  (e.g. `feat/multi-tab-sync`, `fix/health-timeout`, `docs/contributing`).
- PRs target `main`. Squash merges are the norm, so the commit message you
  write is what lands; conventional-commits format is required (see below).
- A passing pre-push gate is a precondition. A passing CI run is required for
  merge.
- Keep PRs focused — one concern per PR. If you find an unrelated issue, open
  a separate issue rather than bundling the fix.

---

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): subject`.

| Type             | When to use                                 | Example                                                     |
| ---------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `feat(api):`     | New public-facing API behavior              | `feat(api): version endpoints at /v1 with deprecation shim` |
| `fix(api):`      | Bug fix on the API                          | `fix(api): graceful shutdown awaits in-flight requests`     |
| `feat(web):`     | Renderer feature                            | `feat(web): add CSP + security headers via vercel.json`     |
| `refactor(...):` | Internal change with no behavioral diff     | `refactor(web): drop 'as any' on the spec handoff`          |
| `test(api):`     | New or modified tests                       | `test(api): handler tests for /v1/new rate limiting`        |
| `chore:`         | Dev tooling, dependency bumps, repo hygiene | `chore: add Husky pre-push hook`                            |
| `ci:`            | CI config changes                           | `ci: add GitHub Actions workflow mirroring pre-push gate`   |
| `docs:`          | README, CONTRIBUTING, SECURITY, etc.        | `docs: add release procedure (docs/RELEASING.md)`           |
| `perf(...):`     | Performance improvements                    | `perf(web): exponential backoff on post-submit poll loop`   |

Rules:

- Subject line: ≤ 70 characters, imperative mood ("add X", not "added X").
- Body: wrap at 72 characters. Explain the _why_, not the _what_.

---

## Code style

- TypeScript. Strict mode where the tsconfig allows it.
- ESLint flat config (`eslint.config.js`) + Prettier — both run in the
  pre-push gate. Do not add `// eslint-disable-...` without a one-line
  comment explaining why.
- Default to no comments. This codebase comments only where the WHY is
  non-obvious.
- Do not introduce backwards-compat shims for unused code; delete it.

---

## Testing

Tests live next to their source as `*.test.ts`.

```bash
npm test              # run once
npm run test:watch    # re-run on change (while iterating)
npm run test:coverage # coverage report
```

- **Unit tests** target pure helpers — no DB, no network.
- **Handler tests** use `app.fetch(new Request(...))` with the DB module
  mocked (see `apps/api/app.test.ts`).
- A real-Postgres integration test is intentionally deferred; don't add one
  without discussing first.

---

## When you change…

| Area                        | Also touch                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/mcp/server.ts`        | Run `npm run build:mcp`, commit the regenerated `server.bundle.js`. CI will fail if the bundle is stale. |
| API request/response shapes | Update Zod schemas in `apps/api/schemas.ts` **and** the API section in `README.md`.                      |
| Env vars                    | Update `apps/api/schemas.ts` `envSchema`, `apps/api/.env.example`, **and** the README deploy section.    |
| Vendored a2ui               | Follow `apps/web/vendor/README.md`.                                                                      |
| Version bump                | Follow `docs/RELEASING.md`.                                                                              |

---

## Quality gate

A Husky `pre-push` hook runs automatically on `git push`. To run it
manually before pushing:

```bash
.husky/pre-push
```

CI mirrors the same steps and additionally runs `build:web` and verifies the
MCP bundle is up to date. Both gates must be green for a PR to merge.

---

## Where to ask

- **Bug or feature request** → [GitHub Issues](https://github.com/blockful/pagent/issues).
- **Security report** → see [SECURITY.md](SECURITY.md).
- **Question about A2UI itself** → upstream at <https://github.com/google/A2UI>.
