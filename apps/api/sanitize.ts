/**
 * Server-side HTML sanitization for the html page format.
 *
 * Runs once on POST /new before storage. Returns the cleaned HTML plus
 * dropped-tag and dropped-attr counts (logged as forensic signal).
 *
 * Strict denylist, not allowlist — we accept arbitrary HTML/CSS/SVG and
 * remove the dangerous parts. Combined with the iframe sandbox + meta-CSP
 * in the renderer this is layer one of three (sanitizer -> CSP -> sandbox).
 */
import DOMPurify from 'isomorphic-dompurify';

const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'embed',
  'object',
  'applet',
  'link', // no external stylesheets
  'base', // we inject our own <base> in the renderer scaffold
  'meta', // no <meta http-equiv=refresh>; renderer injects its own meta-CSP
];

const FORBID_ATTR = ['formaction', 'srcdoc', 'xlink:href'];

// Allow https links, mailto, in-page anchors, and inline image data URIs only.
// Explicitly blocks javascript:, vbscript:, data:text/html, data:application/*.
const ALLOWED_URI_REGEXP =
  /^(?:https:|mailto:|#|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i;

export function sanitize(html: string): {
  output: string;
  removedTags: number;
  removedAttrs: number;
} {
  let removedTags = 0;
  let removedAttrs = 0;

  // Hooks are global per DOMPurify instance. Reset and re-register on each
  // call so the counters start clean. removeAllHooks runs again at the end
  // to leave the instance pristine for the next caller.
  DOMPurify.removeAllHooks();
  DOMPurify.addHook('uponSanitizeElement', (_node, data) => {
    if (data.allowedTags[data.tagName] === false) removedTags++;
  });
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (!data.allowedAttributes[data.attrName]) removedAttrs++;
  });

  const output = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    // <style> is not in the default html profile but is essential for inline
    // CSS (the renderer's CSP allows style-src 'unsafe-inline'). Re-enable it
    // explicitly so payloads with embedded styles aren't silently stripped.
    ADD_TAGS: ['style'],
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    // FORCE_BODY parses the input as body content (rather than a full
    // document), so root-level <style> tags survive instead of being treated
    // as head-only and dropped. The renderer wraps our output inside <body>
    // anyway, so this matches the eventual placement.
    FORCE_BODY: true,
    WHOLE_DOCUMENT: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;

  DOMPurify.removeAllHooks();

  return { output, removedTags, removedAttrs };
}
