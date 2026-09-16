export const SUPPORTED_SCOPES = ['page:create', 'page:read'] as const;
export const DEFAULT_SCOPE = SUPPORTED_SCOPES.join(' ');

type ScopeResult =
  | { readonly ok: true; readonly scope: string }
  | { readonly ok: false; readonly unsupportedScope: string };

export function normalizeRequestedScope(requestedScope: string | undefined): ScopeResult {
  const requested = (requestedScope ?? '').split(/[ \t\r\n\f]+/).filter(Boolean);
  if (requested.length === 0) return { ok: true, scope: DEFAULT_SCOPE };

  const requestedSet = new Set(requested);
  const supportedSet = new Set<string>(SUPPORTED_SCOPES);
  for (const scope of requestedSet) {
    if (!supportedSet.has(scope)) {
      return { ok: false, unsupportedScope: scope };
    }
  }
  return {
    ok: true,
    scope: SUPPORTED_SCOPES.filter((scope) => requestedSet.has(scope)).join(' '),
  };
}
