import { describe, expect, it } from 'vitest';
import { isSpecificAudience } from './deck-sharing-view.ts';

describe('isSpecificAudience', () => {
  it('defaults a new share link to Anyone', () => {
    expect(isSpecificAudience(null)).toBe(false);
  });

  it('keeps an existing restricted link on the specific-audience option', () => {
    expect(isSpecificAudience({ accessMode: 'allowed_email' })).toBe(true);
    expect(isSpecificAudience({ accessMode: 'authenticated' })).toBe(true);
  });
});
