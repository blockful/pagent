import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE, normalizeRequestedScope } from './oauth-scopes.ts';

describe('normalizeRequestedScope', () => {
  it('returns the documented default when scope is omitted or empty', () => {
    expect(normalizeRequestedScope(undefined)).toEqual({ ok: true, scope: DEFAULT_SCOPE });
    expect(normalizeRequestedScope('   ')).toEqual({ ok: true, scope: DEFAULT_SCOPE });
  });

  it('deduplicates and canonicalizes supported scopes', () => {
    expect(normalizeRequestedScope('page:read page:create page:read')).toEqual({
      ok: true,
      scope: 'page:create page:read',
    });
  });

  it('rejects an unsupported scope', () => {
    expect(normalizeRequestedScope('page:create page:admin')).toEqual({
      ok: false,
      unsupportedScope: 'page:admin',
    });
  });
});
