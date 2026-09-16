import { isIP } from 'node:net';
import { env } from './schemas.ts';

/**
 * Extract a stable client-IP key under the configured trusted-ingress
 * contract. Railway strips client-supplied X-Forwarded-For and constructs a
 * chain whose first entry is the connecting client, even when later CDN and
 * internal proxy entries vary. Production explicitly opts into that contract
 * with `TRUSTED_PROXY_MODE=railway`.
 *
 * A missing header or non-IP first entry is deliberately collapsed into the
 * anonymous bucket. That prevents malformed values from minting unbounded
 * attacker-controlled rate-limit keys.
 */
const ANONYMOUS = 'anonymous';

export function clientKey(xForwardedFor: string | readonly string[] | undefined): string {
  if (!xForwardedFor) return ANONYMOUS;
  if (env.TRUSTED_PROXY_MODE !== undefined && env.TRUSTED_PROXY_MODE !== 'railway') {
    return ANONYMOUS;
  }
  const raw = typeof xForwardedFor === 'string' ? xForwardedFor : xForwardedFor.join(',');
  const hops = raw
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const candidate = hops[0];
  return candidate && isIP(candidate) !== 0 ? candidate : ANONYMOUS;
}
