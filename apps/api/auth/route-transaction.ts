import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { env } from '../schemas.ts';

export const AUTH_TRANSACTION_COOKIE_NAME = 'pagent_auth_transaction';
const AUTH_TRANSACTION_TTL_SECONDS = 15 * 60;
const AUTH_TRANSACTION_BYTES = 32;

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax' as const,
    path: '/oauth',
    maxAge,
  };
}

function hashTransactionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function startBrowserTransaction(c: Context): string {
  const token = randomBytes(AUTH_TRANSACTION_BYTES).toString('base64url');
  setCookie(c, AUTH_TRANSACTION_COOKIE_NAME, token, cookieOptions(AUTH_TRANSACTION_TTL_SECONDS));
  return hashTransactionToken(token).toString('base64url');
}

export function clearBrowserTransaction(c: Context): void {
  setCookie(c, AUTH_TRANSACTION_COOKIE_NAME, '', cookieOptions(0));
}

export function verifyBrowserTransaction(c: Context, expectedHash: string | undefined): boolean {
  const token = getCookie(c, AUTH_TRANSACTION_COOKIE_NAME);
  if (!token || !expectedHash) return false;
  const actual = hashTransactionToken(token);
  const expected = Buffer.from(expectedHash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
