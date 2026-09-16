import type { IdentityConfidence } from './domain.ts';

export type AnalyticsVisitRow = {
  readonly id: string;
  readonly viewerSessionId: string;
  readonly viewerUserId: string | null;
  readonly viewerEmail: string | null;
  readonly identityConfidence: IdentityConfidence;
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
  readonly revisionNumber: number;
  readonly linkId: string;
  readonly linkName: string;
  readonly senderId: string;
  readonly senderEmail: string;
  readonly totalSlides: number;
};

export type AnalyticsSlideRow = {
  readonly id: string;
  readonly revisionNumber: number;
  readonly stableSlideId: string;
  readonly ordinal: number;
  readonly title: string | null;
};

export type AnalyticsEngagementRow = AnalyticsSlideRow & {
  readonly visitId: string;
  readonly activeDurationMs: number;
  readonly viewCount: number;
  readonly qualified: boolean;
  readonly firstSequence: number;
  readonly lastSequence: number;
};

export type VisitDetail = {
  readonly id: string;
  readonly viewer: string;
  readonly identityConfidence: IdentityConfidence;
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
  readonly linkId: string;
  readonly linkName: string;
  readonly senderId: string;
  readonly senderEmail: string;
  readonly revisionNumber: number;
  readonly totalActiveTimeMs: number;
  readonly viewedSlides: number;
  readonly completion: number;
  readonly furthestSlide: number | null;
  readonly lastSlide: number | null;
  readonly slideSequence: readonly {
    readonly slideId: string;
    readonly ordinal: number;
    readonly title: string | null;
    readonly activeDurationMs: number;
    readonly viewCount: number;
  }[];
};

type VisitorRollup = {
  readonly viewer: string;
  readonly identityConfidence: IdentityConfidence;
  readonly firstVisit: Date;
  readonly lastVisit: Date;
  readonly visits: number;
  readonly totalActiveTimeMs: number;
  readonly maximumCompletion: number;
};

export type SlideRollup = {
  readonly slideId: string;
  readonly stableSlideId: string;
  readonly revisionNumber: number;
  readonly ordinal: number;
  readonly title: string | null;
  readonly uniqueViewers: number;
  readonly viewRate: number;
  readonly averageActiveTimeMs: number;
  readonly totalActiveTimeMs: number;
  readonly exits: number;
};

export type DeckAnalytics = {
  readonly owner: { readonly id: string; readonly email: string };
  readonly overview: {
    readonly totalVisits: number;
    readonly uniqueViewers: number;
    readonly lastViewed: Date | null;
    readonly averageActiveTimeMs: number;
    readonly averageCompletion: number;
    readonly topSlide: SlideRollup | null;
  };
  readonly visitors: readonly VisitorRollup[];
  readonly slides: readonly SlideRollup[];
  readonly visits: readonly VisitDetail[];
};

export type MutableVisitor = {
  viewer: string;
  identityConfidence: IdentityConfidence;
  firstVisit: Date;
  lastVisit: Date;
  visits: number;
  totalActiveTimeMs: number;
  maximumCompletion: number;
};

export type SlideAccumulator = {
  readonly definition: AnalyticsSlideRow;
  readonly viewers: Set<string>;
  activeDurationMs: number;
  qualifiedVisits: number;
  exits: number;
};

export type AnalyticsAggregationInput = {
  readonly owner: { readonly id: string; readonly email: string };
  readonly visitRows: readonly AnalyticsVisitRow[];
  readonly slideRows: readonly AnalyticsSlideRow[];
  readonly engagementRows: readonly AnalyticsEngagementRow[];
};
