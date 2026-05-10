import { describe, it, expect } from 'vitest';
import { assertCatalogsAllowed } from './spec-guard.js';

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';
const ALLOWED = [BASIC_CATALOG_ID] as const;

describe('assertCatalogsAllowed', () => {
  it('passes when all createSurface catalogIds are in the allowlist', () => {
    const spec = [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: BASIC_CATALOG_ID } },
    ];
    expect(() => assertCatalogsAllowed(spec, ALLOWED)).not.toThrow();
  });

  it('throws when a createSurface catalogId is not in the allowlist', () => {
    const spec = [
      {
        version: 'v0.9',
        createSurface: { surfaceId: 's1', catalogId: 'https://evil.example.com/catalog.json' },
      },
    ];
    expect(() => assertCatalogsAllowed(spec, ALLOWED)).toThrow(
      'This page references an unknown UI catalog. Refusing to render.',
    );
  });

  it('skips messages that have no createSurface key (unknown shape)', () => {
    const spec = [
      { version: 'v0.9', updateComponents: { surfaceId: 's1', components: [] } },
      { totally: 'unrelated' },
      null,
      42,
    ];
    expect(() => assertCatalogsAllowed(spec, ALLOWED)).not.toThrow();
  });

  it('passes for an empty array (no messages)', () => {
    expect(() => assertCatalogsAllowed([], ALLOWED)).not.toThrow();
  });

  it('throws only on the disallowed entry in a mixed spec', () => {
    const spec = [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: BASIC_CATALOG_ID } },
      {
        version: 'v0.9',
        createSurface: { surfaceId: 's2', catalogId: 'https://attacker.example/bad.json' },
      },
    ];
    expect(() => assertCatalogsAllowed(spec, ALLOWED)).toThrow('https://attacker.example/bad.json');
  });
});
