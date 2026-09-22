import { describe, expect, it } from 'vitest';
import { startVisitBodySchema } from './http-schemas.ts';

const readiness = {
  visible: true,
  interacted: true,
  analyticsConsent: true,
  deviceClass: 'desktop',
  browserFamily: 'Chromium',
  countryCode: null,
};

describe('visit revision boundary', () => {
  it('accepts the displayed revision when a valid identifier is supplied', () => {
    // Given
    const revisionId = '11111111-1111-4111-8111-111111111111';
    // When
    const result = startVisitBodySchema.safeParse({ ...readiness, revisionId });
    // Then
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ revisionId });
  });

  it('accepts a shipped client when its request omits the revision', () => {
    // Given / When
    const result = startVisitBodySchema.safeParse(readiness);
    // Then
    expect(result.success).toBe(true);
  });

  it('rejects malformed revision identifiers when starting a visit', () => {
    // Given / When
    const result = startVisitBodySchema.safeParse({ ...readiness, revisionId: 'not-an-id' });
    // Then
    expect(result.success).toBe(false);
  });
});
