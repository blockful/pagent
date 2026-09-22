// @vitest-environment happy-dom

import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerDeck } from './viewer-types.ts';

const api = vi.hoisted(() => ({ empty: vi.fn(), json: vi.fn() }));
vi.mock('./deck-api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deck-api.ts')>()),
  apiEmpty: api.empty,
  apiJson: api.json,
}));

import { EngagementTracker } from './viewer-tracking.ts';
import './deck-viewer.ts';

const deck: ViewerDeck = {
  deckId: crypto.randomUUID(),
  deckTitle: 'Lifecycle fixture',
  revisionId: crypto.randomUUID(),
  revisionNumber: 1,
  shareLinkId: crypto.randomUUID(),
  viewerSessionId: crypto.randomUUID(),
  identityConfidence: 'anonymous',
  preview: false,
  slides: [
    {
      id: crypto.randomUUID(),
      stableSlideId: 'first',
      ordinal: 1,
      title: null,
      html: '<p>First slide</p>',
    },
  ],
};

function pageShow(persisted: boolean) {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

async function activate(viewer: HTMLElement) {
  z.instanceof(EngagementTracker).parse(Reflect.get(viewer, 'tracker')).setVisibleRatio(1);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
}

describe('DeckViewer back-forward cache lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('innerWidth', 1280);
    sessionStorage.setItem('pagent-owner-preview', 'viewer-session');
    api.empty.mockReset().mockResolvedValue(undefined);
    api.json
      .mockReset()
      .mockImplementation(async (path: string) =>
        path === '/v1/viewer/deck' ? deck : { kind: 'started', visitId: crypto.randomUUID() },
      );
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Given a cached viewer whose visit closed, when persisted pageshow restores it, then real activity creates a fresh visit', async () => {
    const viewer = document.createElement('deck-viewer');
    document.body.append(viewer);
    await vi.advanceTimersByTimeAsync(0);
    await activate(viewer);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    pageShow(true);
    await activate(viewer);
    expect(api.json.mock.calls.filter(([path]) => path === '/v1/viewer/visits')).toHaveLength(2);
    expect(api.empty.mock.calls.at(-1)?.[0]).not.toBe(api.empty.mock.calls[0]?.[0]);
  });

  it('Given an active viewer, when ordinary pageshow fires, then its existing visit is retained', async () => {
    const viewer = document.createElement('deck-viewer');
    document.body.append(viewer);
    await vi.advanceTimersByTimeAsync(0);
    await activate(viewer);
    pageShow(false);
    await activate(viewer);
    expect(api.json.mock.calls.filter(([path]) => path === '/v1/viewer/visits')).toHaveLength(1);
  });

  it('Given a disconnected viewer, when persisted pageshow fires, then no observer or tracker is recreated', async () => {
    const viewer = document.createElement('deck-viewer');
    document.body.append(viewer);
    await vi.advanceTimersByTimeAsync(0);
    await activate(viewer);
    viewer.remove();
    const stopped = Reflect.get(viewer, 'tracker');
    pageShow(true);
    expect(Reflect.get(viewer, 'tracker')).toBe(stopped);
    expect(api.json.mock.calls.filter(([path]) => path === '/v1/viewer/visits')).toHaveLength(1);
  });
});
