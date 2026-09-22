import { z } from 'zod';
import { ApiError, apiJson } from './deck-api.ts';
import {
  EngagementDelivery,
  isExpectedTrackingError,
  type EngagementEvent,
} from './viewer-tracking-delivery.ts';

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

type QueuedEvent = {
  readonly eventType: EngagementEvent['eventType'];
  readonly slideId?: string;
  readonly visibleDurationMs: number;
  readonly keepalive?: boolean;
  readonly visibleRatio?: number;
};

export class EngagementTracker {
  private readonly sessionToken: string;
  private readonly currentSlideId: () => string | null;
  private analyticsConsent: boolean;
  private visitId: string | null = null;
  private sequence = 0;
  private visibleRatio = 0;
  private hasInteracted = false;
  private lastActivityAt = Date.now();
  private lastActiveEventAt = Date.now();
  private activeSlideId: string | null;
  private slideQualified = false;
  private tabVisible = document.visibilityState === 'visible';
  private stopped = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private slideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly delivery: EngagementDelivery;
  private starting = false;
  private closeRecorded = false;

  constructor(input: TrackerInput) {
    this.sessionToken = input.sessionToken;
    this.currentSlideId = input.currentSlideId;
    this.analyticsConsent = input.analyticsConsent;
    this.delivery = new EngagementDelivery(input.sessionToken, (error) => {
      if (error.status === 410) this.resetVisit();
      else this.stop();
    });
    this.activeSlideId = input.currentSlideId();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  setConsent(consent: boolean): void {
    this.analyticsConsent = consent;
  }

  setVisibleRatio(ratio: number): void {
    const nextRatio = Math.max(0, Math.min(1, ratio));
    if (this.visibleRatio >= 0.5 !== nextRatio >= 0.5) {
      this.flushInterval();
      this.cancelSlideTimer();
    }
    this.visibleRatio = nextRatio;
    void this.start();
    this.qualifySlide();
  }

  markActivity(): void {
    if (this.stopped) return;
    if (this.visitId !== null && Date.now() - this.lastActiveEventAt >= 30 * 60_000) {
      this.resetVisit();
    }
    const resuming = Date.now() - this.lastActivityAt > 60_000;
    this.lastActivityAt = Date.now();
    this.hasInteracted = true;
    if (resuming) this.flushInterval(0);
    void this.start();
    this.qualifySlide();
  }

  recordSlide(slideId: string): void {
    if (slideId !== this.activeSlideId) {
      this.flushInterval();
      this.activeSlideId = slideId;
      this.slideQualified = false;
      this.cancelSlideTimer();
    }
    this.markActivity();
  }

  private qualifySlide(): void {
    const slideId = this.activeSlideId;
    if (
      this.stopped ||
      this.visitId === null ||
      this.slideTimer !== null ||
      this.slideQualified ||
      slideId === null ||
      this.visibleRatio < 0.5 ||
      !this.tabVisible
    )
      return;
    this.slideTimer = setTimeout(() => {
      this.slideTimer = null;
      if (
        this.currentSlideId() !== slideId ||
        this.visibleRatio < 0.5 ||
        !this.tabVisible ||
        Date.now() - this.lastActivityAt > 60_000
      )
        return;
      this.slideQualified = true;
      void this.enqueue({ eventType: 'slide_view', slideId, visibleDurationMs: 1_000 });
    }, 1_000);
  }

  close(): void {
    if (this.closeRecorded) return;
    this.closeRecorded = true;
    void this.enqueue({
      eventType: 'close',
      slideId: this.activeSlideId ?? undefined,
      visibleDurationMs: 0,
      keepalive: true,
    });
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.cancelSlideTimer();
  }

  private resetVisit(): void {
    this.clearTimers();
    this.visitId = null;
    this.hasInteracted = false;
    this.delivery.setVisit(null);
    this.sequence = 0;
    this.slideQualified = false;
    this.closeRecorded = false;
  }

  private cancelSlideTimer(): void {
    if (this.slideTimer !== null) clearTimeout(this.slideTimer);
    this.slideTimer = null;
  }

  private onVisibilityChange = (): void => {
    const visible = document.visibilityState === 'visible';
    if (visible === this.tabVisible) return;
    if (!visible) this.flushInterval();
    this.tabVisible = visible;
    this.cancelSlideTimer();
    if (visible) {
      this.flushInterval(0);
      void this.start();
    }
    this.qualifySlide();
  };

  private flushInterval(visibleRatio = this.visibleRatio): void {
    void this.enqueue({
      eventType: 'heartbeat',
      slideId: this.activeSlideId ?? undefined,
      visibleDurationMs: 0,
      visibleRatio,
    });
  }

  private async start(): Promise<void> {
    if (
      this.stopped ||
      this.starting ||
      this.visitId !== null ||
      !this.hasInteracted ||
      Date.now() - this.lastActivityAt > 60_000 ||
      this.visibleRatio < 0.5 ||
      !this.tabVisible
    )
      return;
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
      if (this.stopped) return;
      if (result.kind !== 'started') {
        this.stop();
        return;
      }
      this.visitId = result.visitId;
      this.delivery.setVisit(result.visitId);
      this.activeSlideId = this.currentSlideId();
      void this.enqueue({
        eventType: 'start',
        slideId: this.currentSlideId() ?? undefined,
        visibleDurationMs: 0,
        visibleRatio: 0,
      });
      this.qualifySlide();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastActiveEventAt >= 30 * 60_000) return;
        void this.enqueue({
          eventType: 'heartbeat',
          slideId: this.activeSlideId ?? undefined,
          visibleDurationMs: 10_000,
        });
      }, 10_000);
    } catch (error) {
      if (!isExpectedTrackingError(error)) throw error;
      if (error instanceof ApiError && [401, 403, 410].includes(error.status)) this.stop();
    } finally {
      this.starting = false;
    }
  }

  private async enqueue(input: QueuedEvent): Promise<void> {
    if (this.visitId === null || this.stopped) return;
    const event: EngagementEvent = {
      id: crypto.randomUUID(),
      eventType: input.eventType,
      ...(input.slideId === undefined ? {} : { slideId: input.slideId }),
      eventAt: new Date().toISOString(),
      sequence: ++this.sequence,
      visibleRatio: input.visibleRatio ?? this.visibleRatio,
      visibleDurationMs: input.visibleDurationMs,
      tabVisible: this.tabVisible,
      recentlyActive: Date.now() - this.lastActivityAt <= 60_000,
    };
    if (event.tabVisible && event.recentlyActive) this.lastActiveEventAt = Date.now();
    await this.delivery.enqueue(event, input.keepalive === true);
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
