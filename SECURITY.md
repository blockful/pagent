# Security policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in pagent, please **do
not open a public issue**. Instead, report it privately:

- **Preferred:** GitHub's [private security advisories](https://github.com/blockful/pagent/security/advisories/new)
- **Alternate:** email `alex@blockful.io`

Please include:

1. A description of the vulnerability and its impact.
2. Steps to reproduce, ideally with a minimal proof of concept.
3. The version (commit SHA or release tag) you tested against.
4. Whether you'd like to be credited in the fix's release notes.

We aim to acknowledge reports within **48 hours** and ship a fix within
**14 days** for issues we judge critical. Lower-severity issues may take
longer; we'll keep you posted.

## Supported versions

The latest release on the `main` branch (and the most recent `vX.Y.Z`
tag) is supported. We do not backport fixes to older releases at this
time — the project is small enough that the upgrade path is "pull main".

| Version       | Supported          |
| ------------- | ------------------ |
| latest `main` | :white_check_mark: |
| older tags    | :x:                |

## Scope

In scope:

- The hosted API (`apps/api/`) and its endpoints.
- The renderer (`apps/web/`) and the way it consumes A2UI specs.
- The MCP server (`apps/mcp/`) and the bundled `server.bundle.js` shipped
  to plugin users.
- The Claude Code plugin manifest and skill (`.claude-plugin/`, `skills/`).

Out of scope (things we won't treat as vulnerabilities):

- Brute-forcing 128-bit random page IDs.
- Denial-of-service via volume of valid requests below the per-IP rate
  limit. (We'll consider amplification or asymmetric-cost reports.)
- Issues only reproducible by a user with full write access to their own
  Claude Code session.
- Reports against vendored Apache-2.0 code in `apps/web/vendor/` should be
  filed upstream at https://github.com/google/A2UI ; we'll coordinate
  with them on anything we can mitigate at our integration layer.

## Disclosure

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure):
once a fix is shipped, we publish a GitHub Security Advisory describing
the issue and crediting the reporter (unless they prefer otherwise). We
target a disclosure window of 90 days from the initial report; if the
issue is exploited in the wild before that, we'll go public sooner.

## Hardening reference

For operators self-hosting pagent, the production hardening checklist
lives in [`docs/RELEASING.md`](docs/RELEASING.md) (release procedure)
and the README's deploy sections. Notable security-relevant settings:

- `ALLOWED_ORIGINS` is required in production (CORS fail-closed).
- `PUBLIC_URL` is required in production (no hardcoded fallback).
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` cap `POST /v1/new` per IP.
- The renderer ships strict CSP, HSTS, X-Frame-Options DENY in
  `apps/web/vercel.json`.
- The API ships parallel headers via `hono/secure-headers`.
