import { describe, expect, it } from 'vitest';
import { aggregateDeckAnalytics } from './analytics-aggregate.ts';

const startedAt = new Date('2026-09-01T12:00:00.000Z');
const htmlVisit = {
  id: 'html-visit',
  viewerSessionId: 'session',
  viewerUserId: null,
  viewerEmail: 'viewer@example.test',
  identityConfidence: 'unverified' as const,
  startedAt,
  lastActivityAt: startedAt,
  revisionNumber: 2,
  linkId: 'link',
  linkName: 'Customer',
  senderId: 'owner',
  senderEmail: 'owner@example.test',
  totalSlides: 0,
  contentFormat: 'html' as const,
};
const htmlInput = {
  owner: { id: 'owner', email: 'owner@example.test' },
  revisionRows: [{ revisionNumber: 2, contentFormat: 'html' as const }],
  visitRows: [htmlVisit],
  slideRows: [],
  engagementRows: [],
  eventRows: [
    {
      visitId: 'html-visit',
      slideId: null,
      eventAt: startedAt,
      sequence: 1,
      activeDurationMs: 2000,
      qualified: false,
    },
    {
      visitId: 'html-visit',
      slideId: null,
      eventAt: startedAt,
      sequence: 2,
      activeDurationMs: 3000,
      qualified: false,
    },
  ],
};

describe('HTML deck analytics', () => {
  it('uses accepted visit events when an HTML revision has no slide engagement', () => {
    // Given / When
    const result = aggregateDeckAnalytics(htmlInput);

    // Then
    expect(result.visits[0]?.totalActiveTimeMs).toBe(5000);
    expect(result.overview.averageActiveTimeMs).toBe(5000);
  });

  it('reports unknowable slide metrics as unavailable when content is HTML', () => {
    // Given / When
    const result = aggregateDeckAnalytics(htmlInput);

    // Then
    expect(result.visits[0]).toMatchObject({
      viewedSlides: null,
      completion: null,
      furthestSlide: null,
      lastSlide: null,
      slideSequence: [],
    });
    expect(result.visitors[0]?.maximumCompletion).toBeNull();
    expect(result.overview.averageCompletion).toBeNull();
    expect(result.overview.topSlide).toBeNull();
    expect(result.slides).toEqual([]);
  });

  it('classifies selected stored revisions when no visits exist', () => {
    // Given
    const input = { ...htmlInput, visitRows: [], eventRows: [] };

    // When
    const result = aggregateDeckAnalytics(input);

    // Then
    expect(result).toMatchObject({ contentFormat: 'html', revisionNumbers: [2] });
    expect(result.overview.averageCompletion).toBeNull();
  });

  it('retains known slide completion when a viewer also visits an HTML revision', () => {
    // Given
    const slide = {
      id: 'slide',
      revisionNumber: 1,
      stableSlideId: 'cover',
      ordinal: 1,
      title: 'Cover',
    };
    const input = {
      ...htmlInput,
      revisionRows: [
        { revisionNumber: 1, contentFormat: 'slides' as const },
        ...htmlInput.revisionRows,
      ],
      visitRows: [
        ...htmlInput.visitRows,
        {
          ...htmlVisit,
          id: 'slide-visit',
          revisionNumber: 1,
          totalSlides: 1,
          contentFormat: 'slides' as const,
        },
      ],
      slideRows: [slide],
      engagementRows: [
        {
          ...slide,
          visitId: 'slide-visit',
          activeDurationMs: 1000,
          viewCount: 1,
          qualified: true,
          firstSequence: 1,
          lastSequence: 1,
        },
      ],
      eventRows: [
        ...htmlInput.eventRows,
        {
          visitId: 'slide-visit',
          slideId: 'slide',
          eventAt: startedAt,
          sequence: 1,
          activeDurationMs: 1000,
          qualified: true,
        },
      ],
    };

    // When
    const result = aggregateDeckAnalytics(input);

    // Then
    expect(result).toMatchObject({ contentFormat: 'mixed', revisionNumbers: [2, 1] });
    expect(result.visits[1]?.completion).toBe(1);
    expect(result.visitors[0]?.maximumCompletion).toBe(1);
    expect(result.overview.averageCompletion).toBe(1);
    expect(result.overview.averageActiveTimeMs).toBe(3000);
  });
});
