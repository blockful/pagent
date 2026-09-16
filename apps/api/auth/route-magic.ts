import type { Context, Hono } from 'hono';
import { clientKey } from '../client-key.ts';
import { RateLimiter } from '../mcp/rate-limit.ts';
import { env } from '../schemas.ts';
import { getClient, isAllowedOAuthRedirectUri } from './clients-store.ts';
import {
  InvalidMagicLinkError,
  SmtpUnavailableError,
  inspectMagicLink,
  sendMagicLink,
  verifyMagicLink,
} from './magic-link.ts';
import type { AuthVariables } from './middleware.ts';
import { createAuthCode, upsertUser } from './provider.ts';
import { getClientIp, renderError, setSessionCookie } from './route-shared.ts';
import { clearBrowserTransaction, verifyBrowserTransaction } from './route-transaction.ts';
import { createSession } from './session.ts';
import { verifyStateJwt } from './state-jwt.ts';

const MAGIC_SEND_LIMIT = 5;
const MAGIC_SEND_IP_LIMIT = 10;
const MAGIC_SEND_GLOBAL_LIMIT = 50;
const MAGIC_SEND_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthRouter = Hono<{ Variables: AuthVariables }>;

export const magicSendLimiter = new RateLimiter(MAGIC_SEND_LIMIT, MAGIC_SEND_WINDOW_MS);
export const magicSendIpLimiter = new RateLimiter(MAGIC_SEND_IP_LIMIT, MAGIC_SEND_WINDOW_MS);
// This is intentionally per process: it bounds one API replica's SMTP spend
// and resets on restart. The provider's own account quota remains the
// deployment-wide backstop until a shared limiter is introduced.
export const magicSendGlobalLimiter = new RateLimiter(
  MAGIC_SEND_GLOBAL_LIMIT,
  MAGIC_SEND_WINDOW_MS,
);

async function parseMagicSendBody(
  c: Context,
): Promise<{ email?: unknown; state?: unknown } | null> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    return c.req.json().catch(() => null);
  }
  try {
    const form = await c.req.parseBody();
    return form as { email?: unknown; state?: unknown };
  } catch {
    return null;
  }
}

export function registerMagicRoutes(authRoutes: AuthRouter): void {
  authRoutes.post('/oauth/magic/send', async (c) => {
    if (!env.SMTP_HOST) {
      return c.json(
        {
          error: 'service_unavailable',
          message:
            'Magic link sign-in is not configured on this deployment. Please use Google sign-in.',
        },
        503,
      );
    }

    const body = await parseMagicSendBody(c);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid_request', message: 'Request body is malformed.' }, 400);
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const stateInput = typeof body.state === 'string' ? body.state : '';
    if (!email || !EMAIL_REGEX.test(email)) {
      return c.json(
        { error: 'invalid_request', message: 'Please provide a valid email address.' },
        400,
      );
    }
    const lowerEmail = email.toLowerCase();
    const limits = [
      {
        limiter: magicSendLimiter,
        key: lowerEmail,
        message: 'Too many magic link requests for this email',
      },
      {
        limiter: magicSendIpLimiter,
        key: clientKey(c.req.header('x-forwarded-for')),
        message: 'Too many magic link requests from this IP',
      },
      {
        limiter: magicSendGlobalLimiter,
        key: 'provider',
        message: 'Magic link requests are temporarily at capacity',
      },
    ];
    for (const limit of limits) {
      const result = limit.limiter.check(limit.key);
      if (!result.allowed) {
        c.header('Retry-After', String(result.secondsUntilReset));
        return c.json(
          {
            error: 'rate_limited',
            retry_after_seconds: result.secondsUntilReset,
            message: `${limit.message}; retry after ${result.secondsUntilReset} seconds`,
          },
          429,
        );
      }
    }

    let authorizeContext: Parameters<typeof sendMagicLink>[1] = {};
    if (stateInput) {
      try {
        const claims = await verifyStateJwt(stateInput);
        if (
          claims.clientId &&
          (!claims.consentGranted || !verifyBrowserTransaction(c, claims.browserTransactionHash))
        ) {
          return c.json(
            {
              error: 'invalid_request',
              message: 'OAuth consent is missing, expired, or not bound to this browser.',
            },
            400,
          );
        }
        authorizeContext = {
          clientId: claims.clientId,
          redirectUri: claims.redirectUri,
          codeChallenge: claims.codeChallenge,
          codeChallengeMethod: claims.codeChallenge ? 'S256' : undefined,
          scope: claims.scope,
          state: claims.state,
          browserSession: claims.browserSession,
          browserTransactionHash: claims.browserTransactionHash,
          consentGranted: claims.consentGranted,
        };
      } catch {
        // Invalid state intentionally produces an unbound link to avoid an enumeration signal.
      }
    }

    try {
      await sendMagicLink(lowerEmail, authorizeContext);
    } catch (err) {
      if (err instanceof SmtpUnavailableError) {
        return c.json(
          {
            error: 'service_unavailable',
            message:
              'Magic link sign-in is not configured on this deployment. Please use Google sign-in.',
          },
          503,
        );
      }
      throw err;
    }

    return c.json({
      ok: true,
      message: 'Check your email for a sign-in link. The link expires in 15 minutes.',
    });
  });

  authRoutes.get('/oauth/magic', async (c) => {
    c.header('Cache-Control', 'no-store');
    const token = c.req.query('token');
    if (typeof token !== 'string' || token.length === 0) {
      return renderError(c, 'Magic link is missing the token parameter.');
    }

    let inspected: Awaited<ReturnType<typeof inspectMagicLink>>;
    try {
      inspected = await inspectMagicLink(token);
    } catch (err) {
      if (err instanceof InvalidMagicLinkError) {
        return renderError(
          c,
          'This sign-in link has expired or has already been used. Please request a new one.',
        );
      }
      throw err;
    }

    const ctx = inspected.authorizeContext;
    if (ctx.browserSession) {
      const validTransaction = verifyBrowserTransaction(c, ctx.browserTransactionHash);
      if (!validTransaction) {
        clearBrowserTransaction(c);
        return renderError(c, 'Authorization session expired or invalid. Please restart sign-in.');
      }
      let consumed: Awaited<ReturnType<typeof verifyMagicLink>>;
      try {
        consumed = await verifyMagicLink(token);
      } catch (err) {
        if (err instanceof InvalidMagicLinkError) {
          clearBrowserTransaction(c);
          return renderError(
            c,
            'This sign-in link has expired or has already been used. Please request a new one.',
          );
        }
        throw err;
      }
      clearBrowserTransaction(c);
      const user = await upsertUser({ email: consumed.email });
      const sessionToken = await createSession(
        user.id,
        getClientIp(c),
        c.req.header('user-agent') ?? undefined,
      );
      setSessionCookie(c, sessionToken);
      return c.redirect('/', 302);
    }
    if (!ctx.redirectUri) {
      return renderError(
        c,
        'This sign-in link is not bound to an OAuth flow. Please restart sign-in from your client.',
      );
    }
    if (!ctx.clientId || !ctx.codeChallenge) {
      return renderError(
        c,
        'Magic link is missing PKCE binding. Please restart sign-in from your client.',
      );
    }

    const validTransaction = verifyBrowserTransaction(c, ctx.browserTransactionHash);
    if (!ctx.consentGranted || !validTransaction) {
      clearBrowserTransaction(c);
      return renderError(c, 'Authorization consent expired or invalid. Please restart sign-in.');
    }

    const client = await getClient(ctx.clientId);
    if (
      !client ||
      !isAllowedOAuthRedirectUri(ctx.redirectUri) ||
      !client.redirect_uris.includes(ctx.redirectUri)
    ) {
      return renderError(c, 'Client registration changed during sign-in. Please restart.');
    }
    let consumed: Awaited<ReturnType<typeof verifyMagicLink>>;
    try {
      consumed = await verifyMagicLink(token);
    } catch (err) {
      if (err instanceof InvalidMagicLinkError) {
        clearBrowserTransaction(c);
        return renderError(
          c,
          'This sign-in link has expired or has already been used. Please request a new one.',
        );
      }
      throw err;
    }
    clearBrowserTransaction(c);
    const user = await upsertUser({ email: consumed.email });
    const pagentCode = await createAuthCode(
      user.id,
      ctx.clientId,
      ctx.redirectUri,
      ctx.codeChallenge,
      ctx.codeChallengeMethod ?? 'S256',
      ctx.scope ?? null,
    );
    const target = new URL(ctx.redirectUri);
    target.searchParams.set('code', pagentCode);
    if (ctx.state) target.searchParams.set('state', ctx.state);
    return c.redirect(target.toString(), 302);
  });
}
