/**
 * Unit tests for the formatRetryHint helper exported from lib.ts and a
 * structural pin on the PAGENT_TOKEN → Authorization: Bearer wiring in
 * server.ts. Full show_ui / check_result flows are covered by the smoke
 * script (apps/mcp/smoke.mjs); PAGENT_TOKEN behaviour is structural because
 * the env var is captured at module load — testing it dynamically would
 * require re-importing on every case, which is more brittle than the SQL
 * source-probe pattern db.test.ts already uses.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRetryHint } from './lib.ts';

const serverSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'server.ts'),
  'utf8',
);

describe('formatRetryHint', () => {
  it('returns empty string for an empty body', () => {
    expect(formatRetryHint({})).toBe('');
  });

  it('returns retry hint when retry_after_seconds is present', () => {
    expect(formatRetryHint({ retry_after_seconds: 60 })).toBe('Retry after 60s');
  });

  it('returns size hint when max_bytes is present', () => {
    expect(formatRetryHint({ max_bytes: 262144 })).toBe('Reduce body to ≤262144 bytes');
  });

  it('prefers retry_after_seconds over max_bytes when both are present', () => {
    expect(formatRetryHint({ retry_after_seconds: 30, max_bytes: 262144 })).toBe('Retry after 30s');
  });
});

describe('PAGENT_TOKEN wiring (structural)', () => {
  it('PAGENT_TOKEN is declared as an optional string in the env schema', () => {
    expect(serverSource).toMatch(/PAGENT_TOKEN:\s*z\.string\(\)\.optional\(\)/);
  });

  it('authHeaders returns Authorization: Bearer ${PAGENT_TOKEN} when set', () => {
    // The literal `Bearer ${PAGENT_TOKEN}` template ensures the header carries
    // the exact token the agent supplied — no padding, no rotation, no decode.
    expect(serverSource).toMatch(/Authorization:\s*`Bearer \$\{PAGENT_TOKEN\}`/);
  });

  it('authHeaders returns an empty object when PAGENT_TOKEN is unset (grace period)', () => {
    expect(serverSource).toMatch(/PAGENT_TOKEN\s*\?\s*\{\s*Authorization:.*\}\s*:\s*\{\s*\}/);
  });

  it('showUi spreads authHeaders into the outbound POST', () => {
    expect(serverSource).toMatch(
      /headers:\s*\{[^}]*'content-type':\s*'application\/json',\s*\.\.\.authHeaders\(\)/,
    );
  });

  it('checkResult spreads authHeaders into the outbound GET', () => {
    expect(serverSource).toMatch(
      /headers:\s*\{[^}]*accept:\s*'application\/json',\s*\.\.\.authHeaders\(\)/,
    );
  });
});
