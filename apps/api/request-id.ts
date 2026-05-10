import type { Context, Next } from 'hono';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.ts';

export type RequestIdVariables = {
  requestId: string;
  log: typeof logger;
};

const HEADER = 'x-request-id';
const ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/; // accept caller-supplied IDs but bound them

const newId = () => randomBytes(16).toString('hex');

export function requestId() {
  return async (c: Context, next: Next) => {
    const incoming = c.req.header(HEADER);
    const id = incoming && ID_REGEX.test(incoming) ? incoming : newId();
    c.set('requestId', id);
    c.set('log', logger.child({ req_id: id }));
    c.header('X-Request-ID', id);
    await next();
  };
}

export function getRequestId(c: Context): string {
  // Always populated when this middleware ran. Falls back to 'unknown' for
  // robustness (shouldn't happen).
  return c.get('requestId') ?? 'unknown';
}

export function getLog(c: Context): typeof logger {
  return c.get('log') ?? logger;
}
