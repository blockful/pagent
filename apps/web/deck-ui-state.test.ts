import { describe, expect, it } from 'vitest';
import { buildDeckListQuery, nextPreviewIndex, nextRovingTab } from './deck-ui-state.ts';

describe('buildDeckListQuery', () => {
  it('keeps owner and sender filters in the server query', () => {
    // Given a workspace member narrows the library by both responsible people.
    const filters = {
      scope: 'team' as const,
      query: 'quarterly',
      status: 'active' as const,
      ownerId: '2df34233-3a36-4cca-a76a-887e616b4b32',
      senderId: 'db4cb025-98a0-4c57-ad51-502c75f7f6a6',
    };

    // When the UI builds the deck-list request.
    const query = buildDeckListQuery(filters);

    // Then all P0 filters are transmitted without leaking display emails.
    expect(query.get('scope')).toBe('team');
    expect(query.get('q')).toBe('quarterly');
    expect(query.get('status')).toBe('active');
    expect(query.get('owner')).toBe(filters.ownerId);
    expect(query.get('sender')).toBe(filters.senderId);
    expect(query.toString()).not.toContain('@');
  });
});

describe('nextPreviewIndex', () => {
  it('moves through a ten-slide owner preview without leaving its bounds', () => {
    // Given an owner is previewing the last slide of a ten-slide deck.
    const lastSlide = 9;

    // When the owner asks for the next slide and then moves backward.
    const clampedNext = nextPreviewIndex({ current: lastSlide, delta: 1, slideCount: 10 });
    const previous = nextPreviewIndex({ current: clampedNext, delta: -1, slideCount: 10 });

    // Then the preview remains bounded and every prior slide stays reachable.
    expect(clampedNext).toBe(9);
    expect(previous).toBe(8);
  });
});

describe('nextRovingTab', () => {
  const tabs = ['preview', 'overview', 'links', 'access'] as const;

  it('supports wrapped arrow navigation and Home/End selection', () => {
    expect(nextRovingTab(tabs, 'preview', 'ArrowLeft')).toBe('access');
    expect(nextRovingTab(tabs, 'access', 'ArrowRight')).toBe('preview');
    expect(nextRovingTab(tabs, 'links', 'Home')).toBe('preview');
    expect(nextRovingTab(tabs, 'overview', 'End')).toBe('access');
    expect(nextRovingTab(tabs, 'overview', 'Enter')).toBeNull();
  });
});
