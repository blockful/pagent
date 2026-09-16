import { HTML_MAX_BYTES } from '../limits.ts';
import { env } from '../schemas.ts';

export const PORT = env.PORT;
// In production envSchema ensures PUBLIC_URL is set; in dev fall back to localhost.
export const PUBLIC_URL = env.PUBLIC_URL
  ? new URL(env.PUBLIC_URL).origin
  : `http://localhost:${PORT}`;
export const PAGE_TTL_MS = env.PAGE_TTL_MS;
export const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

// The absolute body cap matches HTML_MAX_BYTES — the bodyLimit middleware
// enforces it on the wire body so HTML payloads at the spec'd 1 MB ceiling
// pass through cleanly. The historical 256 KB cap for A2UI specs is enforced
// post-parse in the page route handler. Re-exported through app.ts for tests
// and external callers.
export const MAX_BODY_BYTES = HTML_MAX_BYTES;
export const A2UI_MAX_SPEC_BYTES = 256_000;
