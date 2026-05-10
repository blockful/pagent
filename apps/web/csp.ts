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
      // The dev server doesn't need this (Vite proxies /v1/* same-origin).
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
