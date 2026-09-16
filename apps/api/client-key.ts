import { isIP } from 'node:net';
import { env } from './schemas.ts';

/**
 * Extract a stable client-IP key under the configured trusted-ingress
 * contract. Railway documents X-Real-IP as the connecting client's remote IP.
 * Production explicitly opts into that contract with
 * `TRUSTED_PROXY_MODE=railway`; without it, forwarded identity is not trusted.
 *
 * A missing, duplicated, or non-IP header is deliberately collapsed into the
 * anonymous bucket. That prevents malformed values from minting unbounded
 * attacker-controlled rate-limit keys.
 */
const ANONYMOUS = 'anonymous';

export function clientKey(xRealIp: string | readonly string[] | undefined): string {
  if (env.TRUSTED_PROXY_MODE !== 'railway' || !xRealIp) return ANONYMOUS;
  const candidate = typeof xRealIp === 'string' ? xRealIp.trim() : xRealIp.at(0)?.trim();
  if (typeof xRealIp !== 'string' && xRealIp.length !== 1) return ANONYMOUS;
  return candidate && isIP(candidate) !== 0 ? candidate : ANONYMOUS;
}
