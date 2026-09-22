import { ApiError, apiEmpty } from './deck-api.ts';

export type EngagementEvent = {
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

type PendingEvent = {
  readonly event: EngagementEvent;
  readonly keepalive: boolean;
  attempts: number;
};

const MAX_QUEUED_EVENTS = 20;
const MAX_EVENTS_PER_REQUEST = 10;
const MAX_DELIVERY_ATTEMPTS = 3;

export class EngagementDelivery {
  private visitId: string | null = null;
  private queue: PendingEvent[] = [];
  private inFlight = false;

  constructor(
    private readonly sessionToken: string,
    private readonly onForbidden: (error: ApiError) => void,
  ) {}

  setVisit(visitId: string | null): void {
    this.visitId = visitId;
    this.queue = [];
  }

  async enqueue(event: EngagementEvent, keepalive: boolean): Promise<void> {
    if (this.visitId === null) return;
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      if (event.eventType !== 'close') return;
      this.queue.pop();
    }
    this.queue.push({ event, keepalive, attempts: 0 });
    await this.deliverPending();
  }

  private async deliverPending(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.visitId !== null && this.queue.length > 0) {
        const visitId = this.visitId;
        const queue = this.queue;
        const batch = queue.slice(0, MAX_EVENTS_PER_REQUEST);
        try {
          await apiEmpty(`/v1/viewer/visits/${visitId}/events`, {
            method: 'POST',
            keepalive: batch.some((pending) => pending.keepalive),
            headers: { 'x-viewer-session': this.sessionToken },
            body: JSON.stringify({ events: batch.map((pending) => pending.event) }),
          });
          if (queue === this.queue) this.queue.splice(0, batch.length);
        } catch (error) {
          if (!isExpectedTrackingError(error)) throw error;
          if (queue !== this.queue) continue;
          if (error instanceof ApiError && [401, 403, 410].includes(error.status)) {
            this.queue = [];
            this.onForbidden(error);
            return;
          }
          for (const pending of batch) pending.attempts += 1;
          this.queue = this.queue.filter((pending) => pending.attempts < MAX_DELIVERY_ATTEMPTS);
          return;
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export function isExpectedTrackingError(error: unknown): error is ApiError | TypeError {
  return error instanceof ApiError || error instanceof TypeError;
}
