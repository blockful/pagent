import type {
  AnalyticsAggregationInput,
  AnalyticsEngagementRow,
  AnalyticsEventRow,
  AnalyticsVisitRow,
  DeckAnalytics,
  DeckContentFormat,
  MutableVisitor,
  SlideAccumulator,
  SlideRollup,
  VisitDetail,
} from './analytics-types.ts';
import { qualifyingSlideSequence } from './analytics-sequence.ts';

function viewerKey(visit: AnalyticsVisitRow): string {
  if (visit.viewerUserId !== null) return `user:${visit.viewerUserId}`;
  if (visit.viewerEmail !== null)
    return `link:${visit.linkId}:email:${visit.viewerEmail.toLowerCase()}`;
  return `link:${visit.linkId}:anonymous:${visit.viewerSessionId}`;
}

export function aggregateDeckAnalytics(input: AnalyticsAggregationInput): DeckAnalytics {
  const { owner, visitRows, slideRows, engagementRows, eventRows } = input;
  const revisionFormats = new Map<number, DeckContentFormat>(
    input.revisionRows?.map((revision) => [revision.revisionNumber, revision.contentFormat]) ?? [
      ...slideRows.map((slide) => [slide.revisionNumber, 'slides'] as const),
      ...visitRows.map((visit) => [visit.revisionNumber, visit.contentFormat ?? 'slides'] as const),
    ],
  );
  const formats = new Set(revisionFormats.values());
  const contentFormat = formats.size > 1 ? 'mixed' : (formats.values().next().value ?? 'slides');
  const slidesById = new Map(slideRows.map((slide) => [slide.id, slide]));
  const eventsByVisit = new Map<string, AnalyticsEventRow[]>();
  for (const event of eventRows) {
    const current = eventsByVisit.get(event.visitId) ?? [];
    current.push(event);
    eventsByVisit.set(event.visitId, current);
  }
  const visitRowsById = new Map<string, AnalyticsVisitRow>();
  for (const visit of visitRows) {
    if (!visitRowsById.has(visit.id)) visitRowsById.set(visit.id, visit);
  }
  const engagementsByVisit = new Map<string, AnalyticsEngagementRow[]>();
  for (const engagement of engagementRows) {
    const current = engagementsByVisit.get(engagement.visitId) ?? [];
    current.push(engagement);
    engagementsByVisit.set(engagement.visitId, current);
  }
  const visits: VisitDetail[] = visitRows.map((visit) => {
    const engagements = engagementsByVisit.get(visit.id) ?? [];
    const qualified = engagements.filter((engagement) => engagement.qualified);
    const events = eventsByVisit.get(visit.id) ?? [];
    const sequenceComplete =
      events.every((event) => event.qualified !== null) &&
      (events.length > 0 || engagements.length === 0);
    const slideSequence = sequenceComplete ? qualifyingSlideSequence(events, slidesById) : [];
    const distinct = new Set(qualified.map((engagement) => engagement.id));
    const metricsByFormat = {
      html: {
        totalActiveTimeMs: events.reduce((total, event) => total + event.activeDurationMs, 0),
        viewedSlides: null,
        completion: null,
        furthestSlide: null,
        lastSlide: null,
        sequenceComplete: false,
        slideSequence: [],
      },
      slides: {
        totalActiveTimeMs: engagements.reduce(
          (total, engagement) => total + engagement.activeDurationMs,
          0,
        ),
        viewedSlides: distinct.size,
        completion: visit.totalSlides === 0 ? 0 : distinct.size / visit.totalSlides,
        furthestSlide:
          qualified.length === 0
            ? null
            : Math.max(...qualified.map((engagement) => engagement.ordinal)),
        lastSlide: slideSequence.at(-1)?.ordinal ?? null,
        sequenceComplete,
        slideSequence,
      },
    };
    const visitFormat = visit.contentFormat ?? 'slides';
    return {
      id: visit.id,
      viewer: visit.viewerEmail ?? 'Anonymous',
      identityConfidence: visit.identityConfidence,
      startedAt: visit.startedAt,
      lastActivityAt: visit.lastActivityAt,
      linkId: visit.linkId,
      linkName: visit.linkName,
      senderId: visit.senderId,
      senderEmail: visit.senderEmail,
      revisionNumber: visit.revisionNumber,
      contentFormat: visitFormat,
      ...metricsByFormat[visitFormat],
    };
  });
  const visitDetailsById = new Map<string, VisitDetail>();
  for (const visit of visits) {
    if (!visitDetailsById.has(visit.id)) visitDetailsById.set(visit.id, visit);
  }
  const visitors = new Map<string, MutableVisitor>();
  for (const visit of visitRows) {
    const detail = visitDetailsById.get(visit.id);
    if (detail === undefined) continue;
    const key = viewerKey(visit);
    const current = visitors.get(key);
    if (current === undefined) {
      visitors.set(key, {
        viewer: detail.viewer,
        identityConfidence: detail.identityConfidence,
        firstVisit: detail.startedAt,
        lastVisit: detail.lastActivityAt,
        visits: 1,
        totalActiveTimeMs: detail.totalActiveTimeMs,
        maximumCompletion: detail.completion,
      });
      continue;
    }
    current.firstVisit =
      current.firstVisit < detail.startedAt ? current.firstVisit : detail.startedAt;
    current.lastVisit =
      current.lastVisit > detail.lastActivityAt ? current.lastVisit : detail.lastActivityAt;
    current.visits += 1;
    current.totalActiveTimeMs += detail.totalActiveTimeMs;
    if (detail.completion !== null) {
      current.maximumCompletion = Math.max(current.maximumCompletion ?? 0, detail.completion);
    }
  }
  const slideAccumulators = new Map<string, SlideAccumulator>();
  for (const slide of slideRows) {
    slideAccumulators.set(slide.id, {
      definition: slide,
      viewers: new Set(),
      activeDurationMs: 0,
      qualifiedVisits: 0,
      exits: 0,
    });
  }
  for (const engagement of engagementRows) {
    const accumulator = slideAccumulators.get(engagement.id);
    const visit = visitRowsById.get(engagement.visitId);
    if (accumulator === undefined || visit === undefined) continue;
    accumulator.activeDurationMs += engagement.activeDurationMs;
    if (engagement.qualified) {
      accumulator.viewers.add(viewerKey(visit));
      accumulator.qualifiedVisits += 1;
    }
    const detail = visitDetailsById.get(engagement.visitId);
    if (detail?.completion !== 1 && detail?.lastSlide === engagement.ordinal)
      accumulator.exits += 1;
  }
  const uniqueViewerCount = new Set(visitRows.map(viewerKey)).size;
  const slides: SlideRollup[] = [...slideAccumulators.values()].map((accumulator) => ({
    slideId: accumulator.definition.id,
    stableSlideId: accumulator.definition.stableSlideId,
    revisionNumber: accumulator.definition.revisionNumber,
    ordinal: accumulator.definition.ordinal,
    title: accumulator.definition.title,
    uniqueViewers: accumulator.viewers.size,
    viewRate: uniqueViewerCount === 0 ? 0 : accumulator.viewers.size / uniqueViewerCount,
    averageActiveTimeMs:
      accumulator.qualifiedVisits === 0
        ? 0
        : accumulator.activeDurationMs / accumulator.qualifiedVisits,
    totalActiveTimeMs: accumulator.activeDurationMs,
    exits: accumulator.exits,
  }));
  const totalActive = visits.reduce((total, visit) => total + visit.totalActiveTimeMs, 0);
  const knownCompletions = visits.flatMap((visit) =>
    visit.completion === null ? [] : [visit.completion],
  );
  const averageCompletion =
    knownCompletions.length === 0
      ? contentFormat === 'slides'
        ? 0
        : null
      : knownCompletions.reduce((total, completion) => total + completion, 0) /
        knownCompletions.length;
  const lastViewed = visitRows.reduce<Date | null>(
    (latest, visit) =>
      latest === null || visit.lastActivityAt > latest ? visit.lastActivityAt : latest,
    null,
  );
  const topSlide =
    [...slides].sort((left, right) => right.totalActiveTimeMs - left.totalActiveTimeMs)[0] ?? null;
  return {
    owner,
    contentFormat,
    revisionNumbers: [...revisionFormats.keys()].sort((left, right) => right - left),
    overview: {
      totalVisits: visitRows.length,
      uniqueViewers: uniqueViewerCount,
      lastViewed,
      averageActiveTimeMs: visits.length === 0 ? 0 : totalActive / visits.length,
      averageCompletion,
      topSlide,
    },
    visitors: [...visitors.values()],
    slides,
    visits,
  };
}
