/**
 * Server-rendered HTML login page for `GET /oauth/authorize`.
 *
 * No JS framework, no client-side JS at all — just a static HTML document
 * with two affordances: a "Continue with Google" link (already pointing at
 * Google's consent screen) and a magic-link email form. The page is
 * intentionally minimal so it loads instantly and is easy to audit for XSS.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.4 (login page).
 */
import { buildGoogleAuthUrl } from './google.ts';

export interface LoginPageParams {
  /** Signed state JWT carrying the authorize-request context. Embedded both
   *  in the Google link's `state` query and in the magic-link form's hidden
   *  field so either path can resume the flow. May be undefined when the
   *  page is rendered for a hard error (no valid authorize request). */
  signedState?: string;
  /** Optional user-facing error message. Renders as a styled banner above
   *  the buttons. Already escaped before display — callers pass plain text. */
  error?: string;
}

/**
 * Escape the five HTML special chars that can break out of attribute or
 * text contexts. Used on every server-provided value before interpolation
 * — `error` strings, the state JWT (purely defensive — the JWT charset is
 * already URL-safe), etc.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/**
 * Render the login page HTML. Returns a complete document including the
 * <!DOCTYPE>, <head>, and <body> — caller passes the result straight to
 * `c.html(...)`.
 *
 * Three render modes:
 *   1. Normal: `signedState` set → both buttons functional.
 *   2. Error with state: `error` + `signedState` set → banner + functional
 *      buttons (user can retry; some errors are transient).
 *   3. Hard error: `error` set, no `signedState` → banner only, no buttons.
 *      Used when the authorize request itself was invalid (unknown client_id,
 *      mismatched redirect_uri) so there's nothing to resume.
 */
export function renderLoginPage(params: LoginPageParams): string {
  const { signedState, error } = params;

  // Pre-compute the Google href so a missing GOOGLE_CLIENT_ID throws at
  // render time (the routes layer converts that to a 503 before reaching
  // here, but this ensures a stray call doesn't emit a broken link).
  const googleHref = signedState ? escapeHtml(buildGoogleAuthUrl(signedState)) : null;

  const errorBanner = error
    ? `    <div class="error" role="alert">${escapeHtml(error)}</div>\n`
    : '';

  const buttons = signedState
    ? `    <a class="btn google" href="${googleHref}">Continue with Google</a>
    <div class="divider"><span>or</span></div>
    <form method="POST" action="/oauth/magic/send">
      <input type="hidden" name="state" value="${escapeHtml(signedState)}">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
      <button type="submit" class="btn email">Send magic link</button>
    </form>
`
    : '';

  // Inline CSS keeps the page self-contained — no external stylesheet means
  // no extra request, no FOUC, no CSP gymnastics. Subset of Tailwind-ish
  // defaults; explicit pixel values avoid the system-fonts UA reset surprises.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign in to Pagent</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 400px;
      margin: 0 auto;
      padding: 48px 24px;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 24px; font-weight: 600; margin: 0 0 24px; text-align: center; }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 500;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .btn.google {
      background: white;
      color: #1a1a1a;
      border-color: #d1d5db;
    }
    .btn.google:hover { background: #f9fafb; }
    .btn.email {
      background: #1a1a1a;
      color: white;
      margin-top: 12px;
    }
    .btn.email:hover { background: #000; }
    .divider {
      text-align: center;
      margin: 16px 0;
      position: relative;
      color: #6b7280;
      font-size: 13px;
    }
    .divider::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 1px;
      background: #e5e7eb;
    }
    .divider span { background: #fafafa; padding: 0 12px; position: relative; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    input[type="email"] {
      display: block;
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      font-size: 15px;
      font-family: inherit;
    }
    input[type="email"]:focus {
      outline: 2px solid #2563eb;
      outline-offset: -1px;
      border-color: transparent;
    }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to Pagent</h1>
${errorBanner}${buttons}  </main>
</body>
</html>`;
}
