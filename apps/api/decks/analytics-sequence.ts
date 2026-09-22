import type { AnalyticsEventRow, AnalyticsSlideRow, VisitDetail } from './analytics-types.ts';

export function qualifyingSlideSequence(
  events: readonly AnalyticsEventRow[],
  slides: ReadonlyMap<string, AnalyticsSlideRow>,
): VisitDetail['slideSequence'] {
  const appearances: {
    slideId: string;
    ordinal: number;
    title: string | null;
    activeDurationMs: number;
    viewCount: number;
  }[] = [];
  let current: (typeof appearances)[number] | undefined;
  const ordered = [...events].sort(
    (left, right) =>
      left.eventAt.getTime() - right.eventAt.getTime() || left.sequence - right.sequence,
  );
  for (const event of ordered) {
    const slide = event.slideId === null ? undefined : slides.get(event.slideId);
    if (slide === undefined) {
      current = undefined;
      continue;
    }
    if (current?.slideId !== slide.id || (event.qualified && current.viewCount > 0)) {
      current = {
        slideId: slide.id,
        ordinal: slide.ordinal,
        title: slide.title,
        activeDurationMs: 0,
        viewCount: 0,
      };
      appearances.push(current);
    }
    current.activeDurationMs += event.activeDurationMs;
    if (event.qualified) current.viewCount += 1;
  }
  return appearances.filter((appearance) => appearance.viewCount > 0);
}
