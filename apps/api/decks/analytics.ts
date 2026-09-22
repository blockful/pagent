const HEARTBEAT_CEILING_MS = 10_000;
export const FUTURE_SKEW_MS = 30_000;

export type VisitSummary = {
  readonly completion: number;
  readonly furthestSlide: number | null;
  readonly lastSlide: number | null;
  readonly viewedSlides: number;
};

export function summarizeVisit(
  qualifyingSlideOrdinals: readonly number[],
  totalSlides: number,
): VisitSummary {
  if (qualifyingSlideOrdinals.length === 0 || totalSlides <= 0) {
    return { completion: 0, furthestSlide: null, lastSlide: null, viewedSlides: 0 };
  }
  const distinct = new Set(qualifyingSlideOrdinals);
  return {
    completion: distinct.size / totalSlides,
    furthestSlide: Math.max(...distinct),
    lastSlide: qualifyingSlideOrdinals.at(-1) ?? null,
    viewedSlides: distinct.size,
  };
}

export type HeartbeatIntervalInput = {
  readonly previousAcceptedAt: Date;
  readonly eventAt: Date;
  readonly serverReceivedAt: Date;
  readonly visibleRatio: number;
  readonly tabVisible: boolean;
  readonly recentlyActive: boolean;
};

export function deriveAcceptedInterval(input: HeartbeatIntervalInput): number {
  if (!input.tabVisible || !input.recentlyActive || input.visibleRatio < 0.5) return 0;
  if (input.eventAt.getTime() <= input.previousAcceptedAt.getTime()) return 0;
  if (input.eventAt.getTime() > input.serverReceivedAt.getTime() + FUTURE_SKEW_MS) return 0;
  return Math.min(
    input.eventAt.getTime() - input.previousAcceptedAt.getTime(),
    HEARTBEAT_CEILING_MS,
  );
}
