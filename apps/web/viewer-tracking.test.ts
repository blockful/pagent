// @vitest-environment happy-dom

import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ empty: vi.fn(), json: vi.fn() }));

vi.mock('./deck-api.ts', () => ({
  ApiError: class ApiError extends Error {},
  apiEmpty: api.empty,
  apiJson: api.json,
  loginUrl: () => '/login',
}));

import { EngagementTracker } from './viewer-tracking.ts';
import './deck-viewer.ts';

const requestSchema = z
  .object({ body: z.string().optional(), keepalive: z.boolean().optional() })
  .passthrough();
type RecordedRequest = z.infer<typeof requestSchema>;
const eventBatchSchema = z.object({
  events: z
    .array(z.object({ eventType: z.string(), tabVisible: z.boolean() }))
    .optional()
    .default([]),
});
type RecordedEvent = z.infer<typeof eventBatchSchema>['events'][number];

let tabVisibility: DocumentVisibilityState = 'visible';

function recordedRequest(request: unknown): RecordedRequest | undefined {
  const parsedRequest = requestSchema.safeParse(request);
  return parsedRequest.success ? parsedRequest.data : undefined;
}

function requestEventTypes(request: unknown): readonly string[] {
  return requestEvents(request).map((event) => event.eventType);
}

function requestEvents(request: unknown): readonly RecordedEvent[] {
  const rawBody = recordedRequest(request)?.body ?? '{}';
  return eventBatchSchema.parse(JSON.parse(rawBody)).events;
}

function requestKeepalive(request: unknown): boolean {
  return recordedRequest(request)?.keepalive === true;
}

describe('EngagementTracker retry queue', () => {
  beforeEach(() => {
    api.empty.mockReset();
    api.json.mockReset();
    tabVisibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => tabVisibility);
    vi.stubGlobal('innerWidth', 1280);
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Given an offline event batch, when the next event arrives, then it retries the same event id', async () => {
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(undefined);
    const tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => '9d99dfda-ec83-4667-9b17-5275cc2f493b',
      analyticsConsent: true,
    });

    tracker.setVisibleRatio(1);
    tracker.markActivity();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(1));
    tracker.close();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(2));
    tracker.stop();

    expect(requestEventTypes(api.empty.mock.calls[1]?.[1])).toEqual(['start', 'close']);
  });

  it('Given consecutive page lifecycle signals, when close is requested twice, then it sends one close event', async () => {
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockResolvedValue(undefined);
    const tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => '9d99dfda-ec83-4667-9b17-5275cc2f493b',
      analyticsConsent: true,
    });

    tracker.setVisibleRatio(1);
    tracker.markActivity();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(1));
    tracker.close();
    tracker.close();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(2));
    tracker.stop();

    const closeRequests = api.empty.mock.calls.filter(([, request]) =>
      requestEventTypes(request).includes('close'),
    );
    expect(closeRequests).toHaveLength(1);
    expect(closeRequests.map(([, request]) => requestKeepalive(request))).toEqual([true]);
  });

  it('Given a started visit, when a lifecycle close is requested, then one close request uses keepalive', async () => {
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockResolvedValue(undefined);
    const tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => '9d99dfda-ec83-4667-9b17-5275cc2f493b',
      analyticsConsent: true,
    });

    tracker.setVisibleRatio(1);
    tracker.markActivity();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(1));
    tracker.close();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(2));
    tracker.stop();

    const closeRequests = api.empty.mock.calls.filter(([, request]) =>
      requestEventTypes(request).includes('close'),
    );
    expect(closeRequests).toHaveLength(1);
    expect(closeRequests.map(([, request]) => requestKeepalive(request))).toEqual([true]);
  });

  it('Given an active visit, when the tab hides and returns before pagehide, then tracking resumes and closes exactly once', async () => {
    vi.useFakeTimers();
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockResolvedValue(undefined);
    const tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => null,
      analyticsConsent: true,
    });
    tracker.setVisibleRatio(1);
    tracker.markActivity();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(1));
    const viewer = document.createElement('deck-viewer');
    Reflect.set(viewer, 'tracker', tracker);
    document.body.append(viewer);

    tabVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    tabVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(10_000);

    const eventsBeforePageHide = api.empty.mock.calls.flatMap(([, request]) =>
      requestEvents(request),
    );
    expect(eventsBeforePageHide.filter((event) => event.eventType === 'close')).toHaveLength(0);
    expect(
      eventsBeforePageHide
        .filter((event) => event.eventType === 'heartbeat')
        .map((event) => event.tabVisible),
    ).toEqual([false, true]);

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => {
      const closeEvents = api.empty.mock.calls.flatMap(([, request]) => requestEvents(request));
      expect(closeEvents.filter((event) => event.eventType === 'close')).toHaveLength(1);
    });
  });

  it('Given more pending events than the queue allows, when delivery resumes, then it sends capped batches', async () => {
    vi.useFakeTimers();
    let resumeDelivery: (() => void) | undefined;
    const delayedDelivery = new Promise<void>((resolve) => {
      resumeDelivery = resolve;
    });
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockResolvedValueOnce(undefined).mockReturnValueOnce(delayedDelivery);
    const tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => '9d99dfda-ec83-4667-9b17-5275cc2f493b',
      analyticsConsent: true,
    });

    tracker.setVisibleRatio(1);
    tracker.markActivity();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(251_000);
    expect(api.empty).toHaveBeenCalledTimes(2);
    tracker.close();
    resumeDelivery?.();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(4));
    tracker.stop();

    const deliveredBatchSizes = api.empty.mock.calls
      .slice(1)
      .map(([, request]) => requestEventTypes(request).length);
    expect(deliveredBatchSizes).toEqual([1, 10, 9]);
    const deliveredTypes = api.empty.mock.calls.flatMap(([, request]) =>
      requestEventTypes(request),
    );
    expect(deliveredTypes.filter((eventType) => eventType === 'close')).toHaveLength(1);
  });

  it('Given repeated delivery failures, when the retry limit is reached, then exhausted events are not sent again', async () => {
    vi.useFakeTimers();
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockResolvedValueOnce(undefined).mockRejectedValue(new TypeError('offline'));
    const tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => '9d99dfda-ec83-4667-9b17-5275cc2f493b',
      analyticsConsent: true,
    });

    tracker.setVisibleRatio(1);
    tracker.markActivity();
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(4));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledTimes(5));
    tracker.stop();

    const slideViewRequestCount = api.empty.mock.calls.filter(([, request]) =>
      requestEventTypes(request).includes('slide_view'),
    ).length;
    expect(slideViewRequestCount).toBe(3);
  });
});
