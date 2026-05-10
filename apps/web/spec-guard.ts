/**
 * Defensive allowlist check for incoming A2UI specs.
 *
 * The A2UI MessageProcessor already throws an A2uiStateError when a
 * createSurface message references a catalogId that was not passed to
 * the processor's constructor.  This guard adds a second, explicit gate
 * at our integration boundary so that misuse fails loudly with a clear
 * error message rather than relying on the processor's internal behavior.
 */

/**
 * Walk every message in `spec` and throw if any `createSurface.catalogId`
 * is not present in `allowedIds`.
 *
 * - Treats malformed specs (non-array, missing fields) leniently — only
 *   checks what is well-formed; the processor will surface other shape errors.
 * - Is a no-op for arrays that contain no `createSurface` entries.
 * - Is a no-op when all `catalogId` values are in the allowlist.
 *
 * @throws {Error} if any `createSurface.catalogId` is not in `allowedIds`.
 */
export function assertCatalogsAllowed(spec: unknown, allowedIds: readonly string[]): void {
  if (!Array.isArray(spec)) return;

  for (const message of spec) {
    if (message == null || typeof message !== 'object') continue;
    const msg = message as Record<string, unknown>;

    const cs = msg['createSurface'];
    if (cs == null || typeof cs !== 'object') continue;
    const createSurface = cs as Record<string, unknown>;

    const catalogId = createSurface['catalogId'];
    if (typeof catalogId !== 'string') continue;

    if (!allowedIds.includes(catalogId)) {
      throw new Error(
        `This page references an unknown UI catalog. Refusing to render. (catalogId: ${catalogId})`,
      );
    }
  }
}
