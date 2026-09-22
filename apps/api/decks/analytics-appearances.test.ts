import { describe, expect, it } from 'vitest';
import { aggregateDeckAnalytics } from './analytics-aggregate.ts';

const slides = [1, 2, 3].map((ordinal) => ({
  id: `slide-${ordinal}`,
  stableSlideId: `stable-${ordinal}`,
  ordinal,
  title: `Slide ${ordinal}`,
  revisionNumber: 1,
}));
const input = {
  owner: { id: 'owner', email: 'owner@example.test' },
  visitRows: [
    {
      id: 'visit',
      viewerSessionId: 'session',
      viewerUserId: null,
      viewerEmail: null,
      identityConfidence: 'anonymous' as const,
      startedAt: new Date('2026-09-22T12:00:00Z'),
      lastActivityAt: new Date('2026-09-22T12:00:10Z'),
      revisionNumber: 1,
      linkId: 'link',
      linkName: 'Link',
      senderId: 'owner',
      senderEmail: 'owner@example.test',
      totalSlides: 3,
    },
  ],
  slideRows: slides,
  engagementRows: slides.slice(0, 2).map((slide) => ({
    ...slide,
    visitId: 'visit',
    activeDurationMs: slide.ordinal === 1 ? 6_000 : 4_000,
    viewCount: slide.ordinal === 1 ? 2 : 1,
    qualified: true,
    firstSequence: slide.ordinal,
    lastSequence: slide.ordinal === 1 ? 3 : 2,
  })),
};

function event(slide: number, sequence: number, duration: number) {
  return {
    visitId: 'visit',
    slideId: `slide-${slide}`,
    sequence,
    eventAt: new Date(Date.UTC(2026, 8, 22, 12, 0, sequence)),
    activeDurationMs: duration,
    qualified: true,
  };
}

describe('qualifying analytics appearances', () => {
  it('preserves a return to an earlier slide and counts the final exit there', () => {
    // Given
    const fixture = {
      ...input,
      eventRows: [event(1, 1, 3_000), event(2, 2, 4_000), event(1, 3, 3_000)],
    };
    // When
    const analytics = aggregateDeckAnalytics(fixture);
    // Then
    expect(analytics.visits[0]?.slideSequence.map((slide) => slide.ordinal)).toEqual([1, 2, 1]);
    expect(analytics.visits[0]).toMatchObject({ lastSlide: 1, viewedSlides: 2, completion: 2 / 3 });
    expect(analytics.slides.map((slide) => slide.exits)).toEqual([1, 0, 0]);
  });

  it('counts accepted intervals once across repeated appearances and heartbeats', () => {
    // Given
    const fixture = {
      ...input,
      eventRows: [
        event(1, 1, 1_000),
        { ...event(1, 2, 2_000), qualified: false },
        event(2, 3, 4_000),
        event(1, 4, 3_000),
      ],
    };
    // When
    const sequence = aggregateDeckAnalytics(fixture).visits[0]?.slideSequence;
    // Then
    expect(sequence?.map((slide) => slide.activeDurationMs)).toEqual([3_000, 4_000, 3_000]);
    expect(sequence?.reduce((total, slide) => total + slide.activeDurationMs, 0)).toBe(10_000);
    expect(sequence?.map((slide) => slide.viewCount)).toEqual([1, 1, 1]);
  });

  it('does not turn an unqualified later appearance into the last viewed slide', () => {
    // Given
    const fixture = {
      ...input,
      eventRows: [
        event(1, 1, 3_000),
        event(2, 2, 4_000),
        { ...event(1, 3, 500), qualified: false },
      ],
    };
    // When
    const visit = aggregateDeckAnalytics(fixture).visits[0];
    // Then
    expect(visit?.slideSequence.map((slide) => slide.ordinal)).toEqual([1, 2]);
    expect(visit?.lastSlide).toBe(2);
  });

  it('orders appearances by event time when batches arrive out of order or sequence resets', () => {
    // Given
    const fixture = {
      ...input,
      eventRows: [{ ...event(1, 3, 3_000), sequence: 0 }, event(2, 2, 4_000), event(1, 1, 3_000)],
    };
    // When
    const visit = aggregateDeckAnalytics(fixture).visits[0];
    // Then
    expect(visit?.slideSequence.map((slide) => slide.ordinal)).toEqual([1, 2, 1]);
  });

  it.each([false, true])(
    'preserves historical totals but reports unknown order for legacy or mixed events (mixed: %s)',
    (mixed) => {
      // Given
      const fixture = {
        ...input,
        eventRows: [
          { ...event(1, 1, 3_000), qualified: null },
          { ...event(2, 2, 4_000), qualified: mixed ? true : null },
        ],
      };
      // When
      const analytics = aggregateDeckAnalytics(fixture);
      const visit = analytics.visits[0];
      // Then
      expect(visit).toMatchObject({
        sequenceComplete: false,
        lastSlide: null,
        slideSequence: [],
        viewedSlides: 2,
        completion: 2 / 3,
      });
      expect(visit?.totalActiveTimeMs).toBe(10_000);
      expect(analytics.slides.map((slide) => slide.totalActiveTimeMs)).toEqual([6_000, 4_000, 0]);
      expect(analytics.slides.map((slide) => slide.exits)).toEqual([0, 0, 0]);
    },
  );
});
