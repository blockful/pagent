import { describe, expect, it } from 'vitest';
import {
  analyticsQuerySchema,
  createShareLinkBodySchema,
  matchesAudience,
  normalizeAudience,
  publishDeckBodySchema,
} from './domain.ts';

describe('deck boundary schemas', () => {
  it('accepts a structured multi-slide deck and preserves stable slide ids', () => {
    // Given
    const input = {
      title: 'Northstar renewal',
      description: 'Renewal proposal for the infrastructure team',
      client_label: 'Northstar',
      slides: [
        { id: 'cover', title: 'Northstar renewal', html: '<h1>Northstar</h1>' },
        { id: 'plan', title: 'Plan', html: '<h2>Plan</h2>' },
      ],
    };

    // When
    const result = publishDeckBodySchema.safeParse(input);

    // Then
    expect(result.success).toBe(true);
    if (result.success && 'slides' in result.data)
      expect(result.data.slides.map((slide) => slide.id)).toEqual(['cover', 'plan']);
  });

  it('rejects a share link with a specific audience but no emails or domains', () => {
    // Given
    const input = {
      name: 'Northstar confidential',
      access_mode: 'authenticated',
      allowed_emails: [],
      allowed_domains: [],
    };

    // When
    const result = createShareLinkBodySchema.safeParse(input);

    // Then
    expect(result.success).toBe(false);
  });

  it('maps analytics HTTP filter names into repository filter names', () => {
    // Given
    const linkId = '11111111-1111-4111-8111-111111111111';

    // When
    const filters = analyticsQuerySchema.parse({ link_id: linkId, revision: '3' });

    // Then
    expect(filters).toMatchObject({ linkId, revision: 3 });
    expect(filters).not.toHaveProperty('link_id');
  });
});

describe('allowed audience matching', () => {
  it('normalizes and deduplicates email addresses and domains case-insensitively', () => {
    // Given
    const audience = {
      emails: [' Buyer@Northstar.example ', 'buyer@northstar.example'],
      domains: ['@Northstar.Example', 'northstar.example'],
    };

    // When
    const normalized = normalizeAudience(audience);

    // Then
    expect(normalized).toEqual({
      emails: ['buyer@northstar.example'],
      domains: ['northstar.example'],
    });
  });

  it('matches either an exact email or a domain without matching suffix lookalikes', () => {
    // Given
    const audience = normalizeAudience({
      emails: ['finance@northstar.example'],
      domains: ['trusted.example'],
    });

    // When / Then
    expect(matchesAudience('FINANCE@NORTHSTAR.EXAMPLE', audience)).toBe(true);
    expect(matchesAudience('reader@trusted.example', audience)).toBe(true);
    expect(matchesAudience('reader@nottrusted.example', audience)).toBe(false);
  });
});
