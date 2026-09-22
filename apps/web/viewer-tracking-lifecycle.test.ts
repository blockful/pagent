// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './deck-api.ts';

const api = vi.hoisted(() => ({ empty: vi.fn(), json: vi.fn() }));
vi.mock('./deck-api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deck-api.ts')>()),
  apiEmpty: api.empty,
  apiJson: api.json,
}));

import { EngagementTracker } from './viewer-tracking.ts';

let tracker: EngagementTracker;

describe('EngagementTracker asynchronous lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('innerWidth', 1280);
    api.empty.mockReset().mockResolvedValue(undefined);
    api.json
      .mockReset()
      .mockImplementation(async () => ({ kind: 'started', visitId: crypto.randomUUID() }));
    tracker = new EngagementTracker({
      sessionToken: 'viewer-session',
      currentSlideId: () => 'slide-one',
      analyticsConsent: true,
    });
    tracker.setVisibleRatio(1);
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['stop', 'close'] as const)(
    'Given an unresolved start, when %s happens first, then the late response cannot start events or timers',
    async (action) => {
      let complete: ((result: { kind: 'started'; visitId: string }) => void) | undefined;
      api.json.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      tracker.markActivity();
      tracker[action]();
      complete?.({ kind: 'started', visitId: crypto.randomUUID() });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.empty).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('Given a started visit, when pagehide closes it, then no later activity sends events for the ended visit', async () => {
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(0);
    tracker.close();
    await vi.advanceTimersByTimeAsync(0);
    const requestCount = api.empty.mock.calls.length;
    tracker.recordSlide('slide-two');
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.empty).toHaveBeenCalledTimes(requestCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given the server expires a visit before the client, when activity follows a rejected batch, then one new start is attempted', async () => {
    api.empty.mockRejectedValueOnce(new ApiError(410, 'unavailable', 'Unavailable'));
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.json).toHaveBeenCalledTimes(1);
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.json).toHaveBeenCalledTimes(2);
    expect(api.empty).toHaveBeenCalledTimes(2);
    expect(api.empty.mock.calls[0]?.[0]).not.toBe(api.empty.mock.calls[1]?.[0]);
  });

  it('Given a revoked viewer session, when activity retries after an ingest rejection, then a rejected start stops further retries', async () => {
    api.empty.mockRejectedValueOnce(new ApiError(410, 'unavailable', 'Unavailable'));
    api.json
      .mockResolvedValueOnce({ kind: 'started', visitId: crypto.randomUUID() })
      .mockRejectedValue(new ApiError(410, 'unavailable', 'Unavailable'));
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(0);
    tracker.markActivity();
    await vi.advanceTimersByTimeAsync(0);
    tracker.markActivity();
    tracker.recordSlide('slide-two');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.json).toHaveBeenCalledTimes(2);
    expect(api.empty).toHaveBeenCalledTimes(1);
  });

  it.each(['excluded', 'tracking_disabled'] as const)(
    'Given a %s response, when more activity occurs, then visit creation stays disabled',
    async (kind) => {
      api.json.mockResolvedValue({ kind });
      tracker.markActivity();
      await vi.advanceTimersByTimeAsync(0);
      tracker.markActivity();
      await vi.advanceTimersByTimeAsync(0);
      tracker.recordSlide('slide-two');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.json).toHaveBeenCalledTimes(1);
      expect(api.empty).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
