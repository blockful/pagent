// @vitest-environment happy-dom

import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { renderAnalyticsPanel } from './deck-analytics-view.ts';
import type { DeckAnalytics } from './deck-types.ts';

const visit: DeckAnalytics['visits'][number] = {
  id: crypto.randomUUID(),
  viewer: 'Anonymous',
  identityConfidence: 'anonymous',
  startedAt: '2026-09-22T12:00:00Z',
  lastActivityAt: '2026-09-22T12:00:10Z',
  linkId: crypto.randomUUID(),
  linkName: 'Customer',
  senderId: crypto.randomUUID(),
  senderEmail: 'owner@example.test',
  revisionNumber: 1,
  totalActiveTimeMs: 10_000,
  viewedSlides: 2,
  completion: 2 / 3,
  furthestSlide: 2,
  lastSlide: 1,
  sequenceComplete: true,
  slideSequence: [
    {
      slideId: crypto.randomUUID(),
      ordinal: 1,
      title: 'Opening',
      activeDurationMs: 3000,
      viewCount: 1,
    },
    { slideId: crypto.randomUUID(), ordinal: 2, title: null, activeDurationMs: 4000, viewCount: 1 },
    {
      slideId: crypto.randomUUID(),
      ordinal: 1,
      title: 'Opening',
      activeDurationMs: 3000,
      viewCount: 1,
    },
  ],
};

function overview(currentVisit: typeof visit): HTMLElement {
  const analytics: DeckAnalytics = {
    contentFormat: currentVisit.contentFormat,
    revisionNumbers: [currentVisit.revisionNumber],
    owner: { id: currentVisit.senderId, email: currentVisit.senderEmail },
    overview: {
      totalVisits: 1,
      uniqueViewers: 1,
      lastViewed: currentVisit.lastActivityAt,
      averageActiveTimeMs: 10_000,
      averageCompletion: currentVisit.completion,
      topSlide: null,
    },
    visitors: [],
    slides: [],
    visits: [currentVisit],
  };
  const container = document.createElement('div');
  render(
    renderAnalyticsPanel({
      base: analytics,
      current: analytics,
      view: 'overview',
      filtering: false,
      error: null,
      onApply: vi.fn(),
      onClear: vi.fn(),
      onExport: vi.fn(),
    }),
    container,
  );
  return container;
}

describe('per-visit slide time', () => {
  it('reports HTML page attention without slide navigation or completion metrics', () => {
    const container = overview({
      ...visit,
      contentFormat: 'html',
      completion: null,
      viewedSlides: null,
      furthestSlide: null,
      lastSlide: null,
      slideSequence: [],
    });
    expect(container.textContent).not.toContain('Average completion');
    expect(container.querySelector('[data-label="Completion"]')).toBeNull();
    expect(container.querySelector('[data-label="Document"]')?.textContent).toContain(
      'HTML document · revision 1',
    );
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('#analytics-revision')?.textContent).toContain('Revision 1');
    expect(container.querySelector('[data-label="Active"]')?.textContent).toBe('10s');
  });
  it('shows each ordered appearance and its own duration without replacing distinct completion', () => {
    const container = overview(visit);
    expect(container.querySelector('summary')?.textContent?.trim()).toBe('Time by slide');
    expect(
      Array.from(container.querySelectorAll('details li')).map((item) =>
        item.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Slide 1 · Opening: 3s', 'Slide 2: 4s', 'Slide 1 · Opening: 3s']);
    expect(container.querySelector('[data-label="Completion"]')?.textContent).toBe('67%');
    expect(container.textContent).not.toContain('HTML pages report');
  });

  it('does not invent a breakdown when an older visit has incomplete history', () => {
    const container = overview({
      ...visit,
      sequenceComplete: false,
      slideSequence: [],
      lastSlide: null,
    });
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('[data-label="Sequence"]')?.textContent).toContain(
      'Not recorded (older visit)',
    );
    expect(container.querySelector('[data-label="Active"]')?.textContent).toBe('10s');
  });
});
