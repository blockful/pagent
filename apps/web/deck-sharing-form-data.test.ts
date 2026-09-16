import { describe, expect, it } from 'vitest';
import { parseShareLinkFormData } from './deck-sharing-form-data.ts';

function formData(entries: Readonly<Record<string, string>>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe('parseShareLinkFormData', () => {
  it('clears every audience list when anyone can open the link', () => {
    // Given
    const data = formData({
      name: 'Public review',
      audience: 'anyone',
      allowed: 'buyer@example.com, @example.com',
      require_auth: 'on',
    });

    // When
    const parsed = parseShareLinkFormData(data);

    // Then
    expect(parsed).toMatchObject({
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    });
  });

  it('separates trimmed email and domain entries from comma and newline lists', () => {
    // Given
    const data = formData({
      name: 'Prospects',
      audience: 'specific',
      allowed: ' buyer@example.com, @example.com\npartner.example\n\n',
    });

    // When
    const parsed = parseShareLinkFormData(data);

    // Then
    expect(parsed.allowed_emails).toEqual(['buyer@example.com']);
    expect(parsed.allowed_domains).toEqual(['@example.com', 'partner.example']);
  });

  it('maps a specific audience with the selected authentication checkbox to authenticated', () => {
    // Given
    const data = formData({ name: 'Confidential', audience: 'specific', require_auth: 'on' });

    // When
    const parsed = parseShareLinkFormData(data);

    // Then
    expect(parsed.access_mode).toBe('authenticated');
  });

  it('maps an absent authentication checkbox to allowed email', () => {
    // Given
    const data = formData({ name: 'Named buyers', audience: 'specific' });

    // When
    const parsed = parseShareLinkFormData(data);

    // Then
    expect(parsed.access_mode).toBe('allowed_email');
  });

  it('serializes an optional expiry as an ISO timestamp', () => {
    // Given
    const data = formData({
      name: 'Limited review',
      audience: 'anyone',
      expires_at: '2026-12-24T18:30',
    });

    // When
    const parsed = parseShareLinkFormData(data);

    // Then
    expect(parsed.expires_at).toBe(new Date('2026-12-24T18:30').toISOString());
  });
});
