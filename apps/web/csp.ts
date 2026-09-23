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
  const googleFontsStylesheetOrigin = 'https://fonts.googleapis.com';
  let connectSrc = `'self' ${googleFontsStylesheetOrigin}`;
  let documentSources = "'self'";
  if (apiUrl) {
    try {
      const api = new URL(apiUrl);
      connectSrc = `'self' ${api.origin} ${googleFontsStylesheetOrigin}`;
      const base = `${api.origin}${api.pathname.replace(/\/$/, '')}`;
      documentSources += ` ${base}/v1/viewer/document ${base}/v1/owner/document`;
    } catch {
      connectSrc = `'self' ${googleFontsStylesheetOrigin}`;
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
    `form-action ${documentSources}`,
    `frame-src ${documentSources}`,
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
