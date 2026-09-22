// @vitest-environment happy-dom

import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './deck-api.ts';
import { deriveAcceptedInterval } from '../api/decks/analytics.ts';

const api = vi.hoisted(() => ({ empty: vi.fn(), json: vi.fn() }));
vi.mock('./deck-api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deck-api.ts')>()),
  apiEmpty: api.empty,
  apiJson: api.json,
}));

import { EngagementTracker } from './viewer-tracking.ts';

const slideOne = '9d99dfda-ec83-4667-9b17-5275cc2f493b';
const slideTwo = 'a346aa9b-a08a-4a40-ab8b-d7cf2ac80668';
const eventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  slideId: z.string().optional(),
  eventAt: z.coerce.date(),
  sequence: z.number(),
  visibleRatio: z.number(),
  tabVisible: z.boolean(),
  recentlyActive: z.boolean(),
});
const batchSchema = z.object({ events: z.array(eventSchema) });
let currentSlide: string;
let visibility: DocumentVisibilityState;
let tracker: EngagementTracker;
let startedAt: Date;

function events() {
  return api.empty.mock.calls.flatMap(([, request]) => {
    const { body } = z.object({ body: z.string() }).parse(request);
    return batchSchema.parse(JSON.parse(body)).events;
  });
}

function durations() {
  let boundary = startedAt;
  const totals = new Map<string, number>();
  for (const event of events()) {
    const duration = deriveAcceptedInterval({
      ...event,
      previousAcceptedAt: boundary,
      serverReceivedAt: new Date(),
    });
    if (event.slideId) totals.set(event.slideId, (totals.get(event.slideId) ?? 0) + duration);
    if (event.tabVisible && event.recentlyActive && event.eventAt > boundary)
      boundary = event.eventAt;
  }
  return totals;
}

async function start() {
  tracker.setVisibleRatio(1);
  tracker.markActivity();
  await vi.advanceTimersByTimeAsync(0);
}

describe('EngagementTracker interval and visit boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    startedAt = new Date();
    currentSlide = slideOne;
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.stubGlobal('innerWidth', 1280);
    api.empty.mockReset().mockResolvedValue(undefined);
    api.json
      .mockReset()
      .mockImplementation(async () => ({ kind: 'started', visitId: crypto.randomUUID() }));
    tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => currentSlide,
      analyticsConsent: true,
    });
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Given seven seconds on one slide, when navigation precedes one second on another, then dwell stays with each slide', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(7_000);
    currentSlide = slideTwo;
    tracker.recordSlide(slideTwo);
    await vi.advanceTimersByTimeAsync(1_000);
    tracker.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(durations()).toEqual(
      new Map([
        [slideOne, 7_000],
        [slideTwo, 1_000],
      ]),
    );
  });

  it('Given a qualified slide, when navigation selects it again, then its view count stays one', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    tracker.recordSlide(slideOne);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events().filter((event) => event.eventType === 'slide_view')).toHaveLength(1);
  });

  it('Given half a second visible, when a hidden interval interrupts qualification, then a fresh full second is required', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(500);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(500);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(500);
    expect(
      events().filter((event) => event.eventType === 'slide_view' && event.tabVisible),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(
      events().filter((event) => event.eventType === 'slide_view' && event.tabVisible),
    ).toHaveLength(1);
  });

  it('Given a hidden tab, when it becomes visible again, then the hidden gap is not active time', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(2_000);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(6_000);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(durations().get(slideOne)).toBe(4_000);
  });

  it('Given half a second visible, when slide visibility drops below half, then qualification restarts at the threshold', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(500);
    tracker.setVisibleRatio(0.4);
    await vi.advanceTimersByTimeAsync(500);
    tracker.setVisibleRatio(0.5);
    await vi.advanceTimersByTimeAsync(500);
    expect(events().filter((event) => event.eventType === 'slide_view')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(events().filter((event) => event.eventType === 'slide_view')).toHaveLength(1);
    expect(durations().get(slideOne)).toBe(1_500);
  });

  it('Given a sixty-second idle pause, when navigation resumes, then the new slide receives only its own second', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(65_000);
    currentSlide = slideTwo;
    tracker.recordSlide(slideTwo);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(durations().get(slideTwo)).toBe(1_000);
  });

  it('Given an expired visit, when genuine activity returns, then a new visit starts with a reset sequence', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(31 * 60_000 + 1);
    expect(api.json).toHaveBeenCalledTimes(1);
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.json).toHaveBeenCalledTimes(2);
    expect(
      events()
        .filter((event) => event.eventType === 'start')
        .map((event) => event.sequence),
    ).toEqual([1, 1]);
  });

  it.each(['success', 'failure'])(
    'Given an old in-flight delivery, when activity rolls over before its %s, then old completion cannot consume the new start',
    async (result) => {
      let complete: (() => void) | undefined;
      api.empty.mockReturnValueOnce(
        new Promise<void>((resolve, reject) => {
          complete = () => (result === 'success' ? resolve() : reject(new TypeError('offline')));
        }),
      );
      await start();
      await vi.advanceTimersByTimeAsync(31 * 60_000 + 1);
      tracker.markActivity();
      await vi.advanceTimersByTimeAsync(0);
      complete?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.json).toHaveBeenCalledTimes(2);
      expect(api.empty.mock.calls).toHaveLength(2);
      expect(api.empty.mock.calls[0]?.[0]).not.toBe(api.empty.mock.calls[1]?.[0]);
      expect(events().map((event) => [event.eventType, event.sequence])).toEqual([
        ['start', 1],
        ['start', 1],
      ]);
    },
  );

  it('Given a temporary visit-start failure, when the next activity arrives, then start retries without an unhandled rejection', async () => {
    api.json.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Unavailable'));
    await start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.json).toHaveBeenCalledTimes(1);
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.json).toHaveBeenCalledTimes(2);
    expect(events().map((event) => event.eventType)).toEqual(['start']);
  });
});
