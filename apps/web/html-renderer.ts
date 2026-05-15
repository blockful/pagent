/**
 * Renders agent-submitted HTML inside a maximally-locked-down sandboxed iframe.
 *
 * Layer 1 (server, apps/api/sanitize.ts) — DOMPurify strips dangerous tags/attrs
 *   before storage.
 * Layer 2 (this module) — wraps in a scaffold with strict CSP meta + sets
 *   iframe sandbox="" so the iframe document has an opaque origin and no
 *   capabilities. JS does not run.
 * Layer 3 (browser) — same-origin policy enforces opaque-origin isolation
 *   regardless of what the HTML tries to do.
 *
 * The design assumption that JS is OFF is structural — see
 * docs/superpowers/specs/2026-05-15-html-format-design.md § Structural
 * constraint. If anyone adds allow-scripts, the CI tripwire breaks.
 */
import { buildIframeCsp } from './csp.ts';

/**
 * Wrap the (pre-sanitized) agent HTML in a security-headered scaffold.
 * The scaffold is the document the browser parses inside the iframe.
 */
export function buildScaffoldedHtml(sanitizedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${buildIframeCsp()}">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<base target="_blank" rel="noopener noreferrer nofollow ugc">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>${sanitizedHtml}</body>
</html>`;
}

/**
 * Create an iframe element pre-configured with the lockdown attributes.
 * Caller appends to the DOM; this function never touches `document`.
 *
 * CI tripwire: tests assert sandbox="" with no tokens. Removing or
 * weakening this is a security regression per spec.
 */
export function createSandboxedIframe(sanitizedHtml: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  // CRITICAL: empty string — no tokens. allow-scripts / allow-same-origin
  // are forbidden. See spec § Structural constraint.
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', '');
  iframe.setAttribute('loading', 'lazy');
  iframe.title = 'Agent-generated content';
  iframe.srcdoc = buildScaffoldedHtml(sanitizedHtml);
  iframe.style.cssText = 'width:100%;height:100vh;border:0;display:block';
  return iframe;
}
