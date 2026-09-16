import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { ALLOWED_ORIGINS, PUBLIC_URL } from '../app/config.ts';
import { clientKey } from '../client-key.ts';
import { env } from '../schemas.ts';
import { renderLoginPage } from './login-page.ts';
import { SESSION_COOKIE_NAME } from './middleware.ts';

const SESSION_COOKIE_MAX_AGE_SECONDS = env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

export function browserReturnTarget(value: string | undefined): string {
  if (value === undefined) return PUBLIC_URL;
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return PUBLIC_URL;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return PUBLIC_URL;
  if (target.origin === PUBLIC_URL || ALLOWED_ORIGINS?.includes(target.origin)) {
    return target.toString();
  }
  const developmentHost = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
  return env.NODE_ENV !== 'production' && developmentHost ? target.toString() : PUBLIC_URL;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  });
}

export function getClientIp(c: Context): string | undefined {
  const key = clientKey(c.req.header('x-real-ip'));
  return key === 'anonymous' ? undefined : key;
}

export function renderError(c: Context, message: string, status: 400 | 503 = 400): Response {
  return c.html(renderLoginPage({ error: message }), status);
}
