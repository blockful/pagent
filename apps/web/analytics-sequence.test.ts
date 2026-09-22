import { describe, expect, it } from 'vitest';
import { analyticsSchema } from './deck-types.ts';

describe('visit sequence provenance', () => {
  it('preserves an explicit incomplete history marker when an older visit is parsed', () => {
    const input = {
      id: '00000000-0000-4000-8000-000000000001',
      viewer: 'Anonymous',
      identityConfidence: 'anonymous',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      linkId: '00000000-0000-4000-8000-000000000002',
      linkName: 'Client',
      senderId: '00000000-0000-4000-8000-000000000003',
      senderEmail: 'owner@example.test',
      revisionNumber: 1,
      totalActiveTimeMs: 5000,
      viewedSlides: 2,
      completion: 2 / 3,
      furthestSlide: 2,
      lastSlide: null,
      sequenceComplete: false,
      slideSequence: [],
    };

    const visit = analyticsSchema.shape.visits.element.parse(input);

    expect(visit).toMatchObject({
      sequenceComplete: false,
      totalActiveTimeMs: 5000,
      viewedSlides: 2,
    });
  });
});
