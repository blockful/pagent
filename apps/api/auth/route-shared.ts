import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { env } from '../schemas.ts';
import { renderLoginPage } from './login-page.ts';
import { SESSION_COOKIE_NAME } from './middleware.ts';

const SESSION_COOKIE_MAX_AGE_SECONDS = env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

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
  const xff = c.req.header('x-forwarded-for');
  if (!xff) return undefined;
  const last = xff.split(',').pop()?.trim();
  return last && last.length > 0 ? last : undefined;
}

export async function renderError(c: Context, message: string, status: 400 | 503 = 400) {
  return c.html(renderLoginPage({ error: message }), status);
}
