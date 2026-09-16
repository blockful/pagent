import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ empty: vi.fn(), json: vi.fn() }));

vi.mock('./deck-api.ts', () => ({ apiEmpty: api.empty, apiJson: api.json }));

import { EngagementTracker } from './viewer-tracking.ts';

describe('EngagementTracker retry queue', () => {
  beforeEach(() => {
    api.empty.mockReset();
    api.json.mockReset();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('innerWidth', 1280);
  });

  it('retries an offline event batch with the next event', async () => {
    api.json.mockResolvedValue({ kind: 'started', visitId: crypto.randomUUID() });
    api.empty.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
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

    const secondRequest = api.empty.mock.calls[1]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(secondRequest?.body ?? '{}') as {
      events?: Array<{ eventType: string }>;
    };
    expect(body.events?.map((event) => event.eventType)).toEqual(['start', 'close']);
  });
});
