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
import { env } from '../schemas.ts';
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
  defaultEmail?: string;
  emailInvalid?: boolean;
  oauthAuthorization?: boolean;
}

export interface AuthMessagePageParams {
  readonly title: string;
  readonly detail: string;
  readonly kind: 'status' | 'error';
  readonly action?: {
    readonly href: string;
    readonly label: string;
  };
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

const AUTH_PAGE_STYLES = `
    :root {
      color-scheme: light;
      --pg-canvas: #f4ede1;
      --pg-surface: #fffdf8;
      --pg-surface-subtle: #ebe2d2;
      --pg-ink: #15140f;
      --pg-ink-secondary: #6e685c;
      --pg-rule: #d8cdb9;
      --pg-accent: #c8472f;
      --pg-accent-strong: #9f3524;
      --pg-error-surface: #fdebec;
      --pg-error-ink: #8f2c2a;
      --pg-focus: #7b2f20;
      --pg-font-ui: 'Outfit', system-ui, -apple-system, sans-serif;
      --pg-font-display: 'Instrument Serif', Georgia, 'Times New Roman', serif;
      --pg-font-metadata: 'JetBrains Mono', ui-monospace, monospace;
      --pg-type-xs: 0.6875rem;
      --pg-type-sm: 0.875rem;
      --pg-type-body: 1rem;
      --pg-type-h1: 2.25rem;
      --pg-leading-body: 1.55;
      --pg-control-size: 44px;
      --pg-radius-surface: 12px;
      --pg-radius-control: 8px;
      --pg-motion-micro: 120ms;
      --pg-space-1: 4px;
      --pg-space-2: 8px;
      --pg-space-3: 12px;
      --pg-space-4: 16px;
      --pg-space-5: 20px;
      --pg-space-6: 24px;
      --pg-space-8: 32px;
      --pg-space-12: 48px;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100dvh;
      display: grid;
      place-items: center;
      margin: 0;
      padding: clamp(var(--pg-space-5), 6vw, var(--pg-space-12));
      color: var(--pg-ink);
      background:
        radial-gradient(ellipse at 10% 0%, rgba(200, 71, 47, 0.08), transparent 42%),
        var(--pg-canvas);
      font: 400 var(--pg-type-body) / var(--pg-leading-body) var(--pg-font-ui);
    }
    main {
      width: min(100%, 400px);
      padding: clamp(var(--pg-space-6), 6vw, var(--pg-space-8));
      border: 1px solid var(--pg-rule);
      border-radius: var(--pg-radius-surface);
      background: var(--pg-surface);
    }
    h1 {
      margin: 0 0 var(--pg-space-6);
      font: 400 var(--pg-type-h1) / 1.12 var(--pg-font-display);
      letter-spacing: -0.018em;
      text-align: center;
    }
    .eyebrow {
      margin: 0 0 var(--pg-space-3);
      color: var(--pg-accent);
      font: 600 var(--pg-type-xs) / 1.4 var(--pg-font-metadata);
      letter-spacing: 0.14em;
      text-align: center;
      text-transform: uppercase;
    }
    .error {
      margin-bottom: var(--pg-space-4);
      padding: var(--pg-space-3) var(--pg-space-4);
      border: 1px solid currentColor;
      border-radius: var(--pg-radius-control);
      color: var(--pg-error-ink);
      background: var(--pg-error-surface);
      font-size: var(--pg-type-sm);
    }
    .btn {
      min-height: var(--pg-control-size);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: var(--pg-space-2) var(--pg-space-4);
      border: 1px solid var(--pg-ink);
      border-radius: var(--pg-radius-control);
      color: var(--pg-surface);
      background: var(--pg-ink);
      font: inherit;
      font-weight: 600;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      transition:
        transform var(--pg-motion-micro) ease-out,
        background var(--pg-motion-micro) ease-out,
        border-color var(--pg-motion-micro) ease-out;
    }
    .btn:hover {
      border-color: var(--pg-accent-strong);
      background: var(--pg-accent-strong);
    }
    .btn:active { transform: scale(0.98); }
    .btn.google {
      border-color: var(--pg-rule);
      color: var(--pg-ink);
      background: var(--pg-surface);
    }
    .btn.google:hover { background: var(--pg-surface-subtle); }
    .btn.email { margin-top: var(--pg-space-3); }
    .btn:focus-visible,
    input:focus-visible {
      outline: none;
      box-shadow:
        0 0 0 3px var(--pg-canvas),
        0 0 0 5px var(--pg-focus);
    }
    .divider {
      position: relative;
      margin: var(--pg-space-4) 0;
      color: var(--pg-ink-secondary);
      font-size: var(--pg-type-sm);
      text-align: center;
    }
    .divider::before {
      content: '';
      position: absolute;
      inset: 50% 0 auto;
      height: 1px;
      background: var(--pg-rule);
    }
    .divider span {
      position: relative;
      padding: 0 var(--pg-space-3);
      background: var(--pg-surface);
    }
    label {
      display: block;
      margin-bottom: var(--pg-space-2);
      font-size: var(--pg-type-sm);
      font-weight: 600;
    }
    input[type='email'] {
      min-height: var(--pg-control-size);
      display: block;
      width: 100%;
      padding: var(--pg-space-3);
      border: 1px solid var(--pg-rule);
      border-radius: var(--pg-radius-control);
      color: var(--pg-ink);
      background: var(--pg-surface);
      font: inherit;
    }
    input[aria-invalid='true'] { border-color: var(--pg-error-ink); }
    .message { width: min(100%, 440px); }
    .message h1 { margin-bottom: var(--pg-space-3); }
    .message-detail {
      margin: 0;
      color: var(--pg-ink-secondary);
      text-align: center;
    }
    .message-action { margin-top: var(--pg-space-5); }
    .message.error h1 { color: var(--pg-error-ink); }
    @media (prefers-reduced-motion: reduce) {
      .btn { transition-duration: 0.01ms; }
      .btn:active { transform: none; }
    }
`;

function renderAuthDocument(title: string, mainContent: string, mainClass = ''): string {
  const classAttribute = mainClass ? ` class="${mainClass}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&amp;family=Instrument+Serif&amp;family=JetBrains+Mono:wght@600&amp;display=swap" rel="stylesheet">
  <style>${AUTH_PAGE_STYLES}  </style>
</head>
<body>
  <main${classAttribute}>
${mainContent}  </main>
</body>
</html>`;
}

export function renderAuthMessagePage(params: AuthMessagePageParams): string {
  const { title, detail, kind, action } = params;
  const role = kind === 'error' ? 'alert' : 'status';
  const mainClass = kind === 'error' ? 'message error' : 'message';
  const actionMarkup = action
    ? `    <a class="btn message-action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>\n`
    : '';
  return renderAuthDocument(
    `${title} — Pagent`,
    `    <p class="eyebrow">Pagent</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="message-detail" role="${role}">${escapeHtml(detail)}</p>
${actionMarkup}`,
    mainClass,
  );
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
  const {
    signedState,
    error,
    defaultEmail = '',
    emailInvalid = false,
    oauthAuthorization = false,
  } = params;

  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const googleHref =
    signedState && googleConfigured ? escapeHtml(buildGoogleAuthUrl(signedState)) : null;

  const errorBanner = error
    ? `    <div class="error" id="auth-error" role="alert">${escapeHtml(error)}</div>\n`
    : '';
  const invalidAttributes = emailInvalid
    ? ' aria-invalid="true" aria-describedby="auth-error"'
    : '';

  const googleLabel = oauthAuthorization
    ? 'Allow and continue with Google'
    : 'Continue with Google';
  const emailLabel = oauthAuthorization ? 'Allow and send magic link' : 'Send magic link';
  const googleButton = googleHref
    ? `    <a class="btn google" href="${googleHref}">${googleLabel}</a>
    <div class="divider"><span>or</span></div>
`
    : '';
  const buttons = signedState
    ? `${googleButton}    <form method="POST" action="/oauth/magic/send">
      <input type="hidden" name="state" value="${escapeHtml(signedState)}">
      <label for="email">Email address</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com" value="${escapeHtml(defaultEmail)}"${invalidAttributes}>
      <button type="submit" class="btn email">${emailLabel}</button>
    </form>
`
    : '';

  return renderAuthDocument(
    'Sign in to Pagent',
    `    <p class="eyebrow">Pagent</p>
    <h1>Sign in to Pagent</h1>
${errorBanner}${buttons}`,
  );
}
