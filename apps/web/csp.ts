/**
 * Build the Content-Security-Policy string for the renderer.
 *
 * This is extracted from vite.config.ts so the pure URL→CSP logic can be
 * unit-tested without requiring a Vite context.
 *
 * @param apiUrl - The value of VITE_API_URL (may be undefined in dev / local runs).
 * @returns A complete CSP header value string, directives joined with "; ".
 */
export function buildCsp(apiUrl: string | undefined): string {
  let connectSrc = "'self'";
  if (apiUrl) {
    try {
      connectSrc = `'self' ${new URL(apiUrl).origin}`;
    } catch {
      // VITE_API_URL is malformed — fall back to 'self' only.
      // The dev server doesn't need this (Vite proxies API routes same-origin).
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Build the Content-Security-Policy for the *iframe* that wraps agent-submitted
 * HTML. Injected as a <meta http-equiv> inside the srcdoc scaffold (the iframe
 * has an opaque origin under sandbox="" so per-request HTTP headers aren't an
 * option; meta is what the browser will enforce).
 *
 * default-src 'none' starts every fetch class denied. We re-enable only the
 * narrow set HTML pages need to render: inline styles, inline images via
 * data: URIs, inline fonts via data:. No script, no connect, no form, no
 * external anything. Sandbox at the CSP level is redundant with the iframe
 * sandbox attribute but cheap as a second layer.
 *
 * frame-ancestors is deliberately omitted. The opaque-origin iframe makes
 * 'self' meaningless (every opaque origin is unique and can never match the
 * parent). The shell origin sets X-Frame-Options: DENY upstream, which is
 * what would have been protected here.
 */
export function buildIframeCsp(): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    'font-src data:',
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    'sandbox',
  ].join('; ');
}
