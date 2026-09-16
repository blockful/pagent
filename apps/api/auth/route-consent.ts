import type { Context, Hono } from 'hono';
import { getClient, isAllowedOAuthRedirectUri } from './clients-store.ts';
import { renderLoginPage } from './login-page.ts';
import type { AuthVariables } from './middleware.ts';
import { clearBrowserTransaction, verifyBrowserTransaction } from './route-transaction.ts';
import { signStateJwt, verifyStateJwt } from './state-jwt.ts';

type AuthRouter = Hono<{ Variables: AuthVariables }>;

function renderNoStoreHtml(c: Context, html: string, status: 200 | 400 = 200): Response {
  c.header('Cache-Control', 'no-store');
  return c.html(html, status);
}

async function parseConsentDecision(
  c: Context,
): Promise<{ readonly state: string; readonly decision: string } | null> {
  try {
    const body = await c.req.parseBody();
    const state = typeof body.state === 'string' ? body.state : '';
    const decision = typeof body.decision === 'string' ? body.decision : '';
    return state && decision ? { state, decision } : null;
  } catch {
    return null;
  }
}

export function registerConsentRoutes(authRoutes: AuthRouter): void {
  authRoutes.post('/oauth/authorize/consent', async (c) => {
    const body = await parseConsentDecision(c);
    if (!body || (body.decision !== 'allow' && body.decision !== 'cancel')) {
      clearBrowserTransaction(c);
      return renderNoStoreHtml(
        c,
        renderLoginPage({ error: 'Authorization decision is missing or invalid.' }),
        400,
      );
    }

    let claims: Awaited<ReturnType<typeof verifyStateJwt>>;
    try {
      claims = await verifyStateJwt(body.state);
    } catch {
      clearBrowserTransaction(c);
      return renderNoStoreHtml(
        c,
        renderLoginPage({ error: 'Authorization session expired or invalid. Please restart.' }),
        400,
      );
    }

    if (
      claims.browserSession ||
      claims.consentGranted ||
      !claims.clientId ||
      !claims.redirectUri ||
      !claims.codeChallenge ||
      !verifyBrowserTransaction(c, claims.browserTransactionHash)
    ) {
      clearBrowserTransaction(c);
      return renderNoStoreHtml(
        c,
        renderLoginPage({ error: 'Authorization session expired or invalid. Please restart.' }),
        400,
      );
    }

    const client = await getClient(claims.clientId);
    if (
      !client ||
      !isAllowedOAuthRedirectUri(claims.redirectUri) ||
      !client.redirect_uris.includes(claims.redirectUri)
    ) {
      clearBrowserTransaction(c);
      return renderNoStoreHtml(
        c,
        renderLoginPage({ error: 'Client registration changed. Please restart authorization.' }),
        400,
      );
    }

    if (body.decision === 'cancel') {
      clearBrowserTransaction(c);
      return renderNoStoreHtml(c, renderLoginPage({ error: 'Authorization cancelled.' }));
    }

    const consentedState = await signStateJwt({ ...claims, consentGranted: true });
    return renderNoStoreHtml(
      c,
      renderLoginPage({ signedState: consentedState, oauthAuthorization: true }),
    );
  });
}
