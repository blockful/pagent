/**
 * Magic Link (passwordless email) generation + verification + email send.
 *
 * The flow:
 *   1. `sendMagicLink(email, ctx)` mints a 32-byte random token, stores its
 *      SHA-256 hash + the authorize context in `magic_links` with a 15-min
 *      TTL, and emails the user the URL `${PUBLIC_URL}/oauth/magic?token=<raw>`.
 *   2. The user clicks the link. `verifyMagicLink(token)` re-hashes the raw
 *      value, looks the row up, atomically flips `consumed_at`, and returns
 *      the stored email + context so the route can mint a Pagent auth code
 *      and 302 the browser back to the MCP client's `redirect_uri`.
 *
 * Hashing on the way in (`SHA-256(token)`) is the same defense-in-depth
 * pattern we use for `refresh_tokens` and `sessions`: a DB leak yields hashes
 * that aren't useful without inverting SHA-256.
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.8, §4.3, §7.6.
 */
import { createHash, randomBytes } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import * as db from '../db.ts';
import { env } from '../schemas.ts';

// 32 bytes (256 bits) — matches the auth-code / refresh-token sizing. base64url
// yields 43 url-safe chars, fits trivially in a `mailto:` body or a `<a href>`.
const TOKEN_BYTES = 32;

// 15-minute TTL per spec §2.6. Long enough for a user to switch tabs and read
// the email; short enough that a stolen URL becomes useless quickly.
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * Hash a raw token to its DB-stored representation. Pure SHA-256 (hex) — no
 * salt, no HMAC: the token itself is 256 bits of entropy, salting buys
 * nothing, and a leaked HMAC key would expose every hash. Matches the
 * `refresh_tokens.token_hash` / `sessions.token_hash` storage strategy.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Build the absolute magic link URL. We derive the base from PUBLIC_URL so
 * dev (localhost:8787) and prod (api.pagent.link) both work without
 * per-environment branching. The token is appended raw — URL-safe base64
 * doesn't need percent-encoding.
 */
function buildMagicUrl(token: string): string {
  const base = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;
  return `${base}/oauth/magic?token=${token}`;
}

/**
 * Create the nodemailer SMTP transport. Returns null when SMTP_HOST is unset
 * so callers can render a 503 instead of trying to send. `secure: true` is
 * implied by port 465 (SMTPS); 587 + STARTTLS is the modern default. We
 * never call `verify()` here — that would add a round-trip on every cold
 * start and most providers (SendGrid, Postmark) reject SMTP probes anyway.
 */
export function createTransport(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

/** Plain-text email body. Kept identical to the HTML body so screen readers
 *  and text-only clients see the same instructions. */
function plainBody(url: string): string {
  return [
    `Click this link to sign in to Pagent: ${url}`,
    'This link expires in 15 minutes and can only be used once.',
    '',
    "If you didn't request this email, you can safely ignore it.",
  ].join('\n');
}

/** Minimal HTML body — a single paragraph + button-styled link. Inline
 *  styles so it renders in every email client without a stylesheet. */
function htmlBody(url: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 16px;">Sign in to Pagent</h2>
  <p style="margin: 0 0 16px; font-size: 15px;">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
  <p style="margin: 0 0 16px;"><a href="${url}" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 20px; border-radius: 8px; font-weight: 500; text-decoration: none;">Sign in to Pagent</a></p>
  <p style="font-size: 13px; color: #6b7280; margin: 24px 0 0;">If the button doesn't work, copy and paste this URL into your browser:<br><span style="word-break: break-all;">${url}</span></p>
  <p style="font-size: 13px; color: #6b7280; margin: 16px 0 0;">If you didn't request this email, you can safely ignore it.</p>
</body>
</html>`;
}

/**
 * Custom error for the route layer to distinguish "SMTP not configured"
 * from "SMTP send failed" — the former is a 503 (operator misconfiguration),
 * the latter is a 502 / 500 (transient infrastructure). We throw the same
 * symbol the routes layer can `instanceof`-check without coupling them to a
 * string match on the message.
 */
export class SmtpUnavailableError extends Error {
  constructor() {
    super('SMTP_HOST is not configured — magic link emails unavailable.');
    this.name = 'SmtpUnavailableError';
  }
}

/**
 * Send a magic link email. Generates a fresh 32-byte token, stores its
 * SHA-256 hash + the authorize context, then dispatches the email via
 * nodemailer.
 *
 * Throws SmtpUnavailableError when SMTP_HOST is not set. Other failures
 * (DB error, transport error) propagate as-is — the route layer logs them
 * via the global error handler and returns 500.
 *
 * The raw token is returned only for test purposes — production callers
 * (the POST /oauth/magic/send route) discard it. The user receives the URL
 * via email; never echo the token in the HTTP response.
 */
export async function sendMagicLink(
  email: string,
  authorizeContext: db.MagicLinkAuthorizeContext,
): Promise<{ token: string }> {
  const transport = createTransport();
  if (!transport) throw new SmtpUnavailableError();

  // base64url is URL-safe (no padding, no `+/=`) so the link works in `<a
  // href>` and clipboard pastes without percent-encoding.
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  // Insert first, send second. If the insert fails, no email goes out and the
  // user can retry. If we sent first and the insert failed, the user would
  // get a link that fails verification — worse UX than a transient 500.
  await db.insertMagicLink({
    email,
    tokenHash,
    authorizeContext,
    expiresAt,
  });

  const url = buildMagicUrl(token);
  await transport.sendMail({
    from: env.SMTP_FROM,
    to: email,
    subject: 'Sign in to Pagent',
    text: plainBody(url),
    html: htmlBody(url),
  });

  return { token };
}

/**
 * Custom error for verifyMagicLink — distinct from a thrown TypeError so the
 * route layer can map it to a clean user-facing message. Surfaces the same
 * generic text for unknown / expired / consumed tokens; distinguishing them
 * would leak whether a token was ever issued for a given email.
 */
export class InvalidMagicLinkError extends Error {
  constructor() {
    super('Magic link is invalid, expired, or already used.');
    this.name = 'InvalidMagicLinkError';
  }
}

/**
 * Verify a magic link token. Re-hashes the raw value, atomically consumes
 * the row (UPDATE ... RETURNING), and returns the email + stored authorize
 * context.
 *
 * Throws InvalidMagicLinkError when the token is unknown / expired / already
 * consumed. The route layer renders the login page with a generic error in
 * each case — distinguishing them would leak verification state.
 */
export async function verifyMagicLink(
  token: string,
): Promise<{ email: string; authorizeContext: db.MagicLinkAuthorizeContext }> {
  // Reject the empty string up front — saves a DB round-trip and is the only
  // input we can validate without leaking timing info (every other failure
  // mode goes through the DB so timing is bounded by the same query).
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidMagicLinkError();
  }
  const tokenHash = hashToken(token);
  const row = await db.verifyAndConsumeMagicLink(tokenHash);
  if (!row) throw new InvalidMagicLinkError();
  return row;
}

// Re-export the TTL so tests can assert the configured value without
// duplicating the constant. Not exported as `MAGIC_LINK_TTL_MS` to avoid
// shadowing the local constant on import.
export const MAGIC_LINK_TTL_SECONDS = MAGIC_LINK_TTL_MS / 1000;
