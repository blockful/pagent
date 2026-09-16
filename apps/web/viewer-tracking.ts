import { z } from 'zod';
import { apiEmpty, apiJson } from './deck-api.ts';

const startVisitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), visitId: z.string().uuid() }),
  z.object({ kind: z.literal('excluded') }),
  z.object({ kind: z.literal('tracking_disabled') }),
]);

type TrackerInput = {
  readonly sessionToken: string;
  readonly currentSlideId: () => string | null;
  readonly analyticsConsent: boolean;
};

type EngagementEvent = {
  readonly id: string;
  readonly eventType: 'start' | 'heartbeat' | 'slide_view' | 'close';
  readonly slideId?: string;
  readonly eventAt: string;
  readonly sequence: number;
  readonly visibleRatio: number;
  readonly visibleDurationMs: number;
  readonly tabVisible: boolean;
  readonly recentlyActive: boolean;
};

type QueuedEvent = {
  readonly eventType: EngagementEvent['eventType'];
  readonly slideId?: string;
  readonly visibleDurationMs: number;
  readonly keepalive?: boolean;
};

export class EngagementTracker {
  private readonly sessionToken: string;
  private readonly currentSlideId: () => string | null;
  private analyticsConsent: boolean;
  private visitId: string | null = null;
  private sequence = 0;
  private visibleRatio = 0;
  private lastActivityAt = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private slideTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: EngagementEvent[] = [];
  private starting = false;

  constructor(input: TrackerInput) {
    this.sessionToken = input.sessionToken;
    this.currentSlideId = input.currentSlideId;
    this.analyticsConsent = input.analyticsConsent;
  }

  setConsent(consent: boolean): void {
    this.analyticsConsent = consent;
  }

  setVisibleRatio(ratio: number): void {
    this.visibleRatio = Math.max(0, Math.min(1, ratio));
  }

  markActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.visibleRatio >= 0.5 && this.visitId === null) void this.start();
  }

  recordSlide(slideId: string): void {
    this.markActivity();
    if (this.slideTimer !== null) clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      if (this.currentSlideId() !== slideId || this.visibleRatio < 0.5) return;
      void this.enqueue({ eventType: 'slide_view', slideId, visibleDurationMs: 1_000 });
    }, 1_000);
  }

  close(): void {
    if (this.visitId !== null)
      void this.enqueue({
        eventType: 'close',
        slideId: this.currentSlideId() ?? undefined,
        visibleDurationMs: 0,
        keepalive: true,
      });
  }

  stop(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.slideTimer !== null) clearTimeout(this.slideTimer);
    this.heartbeat = null;
    this.slideTimer = null;
  }

  private async start(): Promise<void> {
    if (this.starting || this.visitId !== null) return;
    this.starting = true;
    try {
      const result = await apiJson('/v1/viewer/visits', startVisitSchema, {
        method: 'POST',
        headers: { 'x-viewer-session': this.sessionToken },
        body: JSON.stringify({
          visible: this.visibleRatio >= 0.5,
          interacted: true,
          analyticsConsent: this.analyticsConsent,
          deviceClass: deviceClass(),
          browserFamily: browserFamily(),
          countryCode: null,
        }),
      });
      if (result.kind !== 'started') return;
      this.visitId = result.visitId;
      await this.enqueue({
        eventType: 'start',
        slideId: this.currentSlideId() ?? undefined,
        visibleDurationMs: 0,
      });
      const slideId = this.currentSlideId();
      if (slideId !== null) this.recordSlide(slideId);
      this.heartbeat = setInterval(() => {
        void this.enqueue({
          eventType: 'heartbeat',
          slideId: this.currentSlideId() ?? undefined,
          visibleDurationMs: 10_000,
        });
      }, 10_000);
    } finally {
      this.starting = false;
    }
  }

  private async enqueue(input: QueuedEvent): Promise<void> {
    if (this.visitId === null) return;
    const event: EngagementEvent = {
      id: crypto.randomUUID(),
      eventType: input.eventType,
      ...(input.slideId === undefined ? {} : { slideId: input.slideId }),
      eventAt: new Date().toISOString(),
      sequence: ++this.sequence,
      visibleRatio: this.visibleRatio,
      visibleDurationMs: input.visibleDurationMs,
      tabVisible: document.visibilityState === 'visible',
      recentlyActive: Date.now() - this.lastActivityAt <= 60_000,
    };
    this.queue = [...this.queue, event];
    const pending = this.queue;
    try {
      await apiEmpty(`/v1/viewer/visits/${this.visitId}/events`, {
        method: 'POST',
        keepalive: input.keepalive,
        headers: { 'x-viewer-session': this.sessionToken },
        body: JSON.stringify({ events: pending }),
      });
      this.queue = this.queue.filter((queued) => !pending.some((sent) => sent.id === queued.id));
    } catch (error) {
      // Network and API failures intentionally leave the batch queued. A later event retries the
      // same idempotency keys, while non-Error throws still surface as programming defects.
      if (!(error instanceof Error)) throw error;
    }
  }
}

function deviceClass(): 'mobile' | 'tablet' | 'desktop' {
  if (innerWidth < 640) return 'mobile';
  if (innerWidth < 1024) return 'tablet';
  return 'desktop';
}

function browserFamily(): string {
  const agent = navigator.userAgent;
  if (agent.includes('Firefox/')) return 'Firefox';
  if (agent.includes('Edg/')) return 'Edge';
  if (agent.includes('Chrome/')) return 'Chromium';
  if (agent.includes('Safari/')) return 'Safari';
  return 'Other';
}
