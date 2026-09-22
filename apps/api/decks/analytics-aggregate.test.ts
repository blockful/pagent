import { describe, expect, it } from 'vitest';
import { aggregateDeckAnalytics } from './analytics-aggregate.ts';
import {
  analyticsInput,
  firstStartedAt,
  firstLastActivityAt,
  secondStartedAt,
  secondLastActivityAt,
} from './analytics-aggregate-fixture.ts';

describe('deck analytics aggregation', () => {
  it('rolls up visits and engagements by visit identifier', () => {
    // Given

    // When
    const eventRows = analyticsInput.engagementRows.map((row) => ({
      visitId: row.visitId,
      slideId: row.id,
      eventAt: firstStartedAt,
      sequence: row.firstSequence,
      activeDurationMs: row.activeDurationMs,
      qualified: row.qualified,
    }));
    const analytics = aggregateDeckAnalytics({ ...analyticsInput, eventRows });

    // Then
    expect(analytics).toEqual({
      owner: analyticsInput.owner,
      contentFormat: 'slides',
      revisionNumbers: [1],
      overview: {
        totalVisits: 2,
        uniqueViewers: 2,
        lastViewed: secondLastActivityAt,
        averageActiveTimeMs: 200,
        averageCompletion: 0.75,
        topSlide: {
          slideId: 'slide-1',
          stableSlideId: 'stable-slide-1',
          revisionNumber: 1,
          ordinal: 1,
          title: 'Introduction',
          uniqueViewers: 2,
          viewRate: 1,
          averageActiveTimeMs: 100,
          totalActiveTimeMs: 200,
          exits: 1,
        },
      },
      visitors: [
        {
          viewer: 'viewer@example.test',
          identityConfidence: 'authenticated',
          firstVisit: firstStartedAt,
          lastVisit: firstLastActivityAt,
          visits: 1,
          totalActiveTimeMs: 300,
          maximumCompletion: 1,
        },
        {
          viewer: 'Anonymous',
          identityConfidence: 'anonymous',
          firstVisit: secondStartedAt,
          lastVisit: secondLastActivityAt,
          visits: 1,
          totalActiveTimeMs: 100,
          maximumCompletion: 0.5,
        },
      ],
      slides: [
        {
          slideId: 'slide-1',
          stableSlideId: 'stable-slide-1',
          revisionNumber: 1,
          ordinal: 1,
          title: 'Introduction',
          uniqueViewers: 2,
          viewRate: 1,
          averageActiveTimeMs: 100,
          totalActiveTimeMs: 200,
          exits: 1,
        },
        {
          slideId: 'slide-2',
          stableSlideId: 'stable-slide-2',
          revisionNumber: 1,
          ordinal: 2,
          title: 'Details',
          uniqueViewers: 1,
          viewRate: 0.5,
          averageActiveTimeMs: 200,
          totalActiveTimeMs: 200,
          exits: 0,
        },
      ],
      visits: [
        {
          id: 'visit-1',
          viewer: 'viewer@example.test',
          identityConfidence: 'authenticated',
          startedAt: firstStartedAt,
          lastActivityAt: firstLastActivityAt,
          linkId: 'link-1',
          linkName: 'Customer link',
          senderId: 'sender-1',
          senderEmail: 'sender@example.test',
          revisionNumber: 1,
          totalActiveTimeMs: 300,
          contentFormat: 'slides',
          viewedSlides: 2,
          completion: 1,
          furthestSlide: 2,
          lastSlide: 1,
          sequenceComplete: true,
          slideSequence: [
            {
              slideId: 'slide-2',
              ordinal: 2,
              title: 'Details',
              activeDurationMs: 200,
              viewCount: 1,
            },
            {
              slideId: 'slide-1',
              ordinal: 1,
              title: 'Introduction',
              activeDurationMs: 100,
              viewCount: 1,
            },
          ],
        },
        {
          id: 'visit-2',
          viewer: 'Anonymous',
          identityConfidence: 'anonymous',
          startedAt: secondStartedAt,
          lastActivityAt: secondLastActivityAt,
          linkId: 'link-1',
          linkName: 'Customer link',
          senderId: 'sender-1',
          senderEmail: 'sender@example.test',
          revisionNumber: 1,
          totalActiveTimeMs: 100,
          contentFormat: 'slides',
          viewedSlides: 1,
          completion: 0.5,
          furthestSlide: 1,
          lastSlide: 1,
          sequenceComplete: true,
          slideSequence: [
            {
              slideId: 'slide-1',
              ordinal: 1,
              title: 'Introduction',
              activeDurationMs: 100,
              viewCount: 1,
            },
          ],
        },
      ],
    });
  });
});
