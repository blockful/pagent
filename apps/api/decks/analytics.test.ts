import { describe, expect, it } from 'vitest';
import { deriveAcceptedInterval, summarizeVisit } from './analytics.ts';

describe('visit summary metrics', () => {
  it('reports furthest slide independently from completion when slides are skipped', () => {
    // Given
    const slideOrdinals = [1, 10];

    // When
    const summary = summarizeVisit(slideOrdinals, 10);

    // Then
    expect(summary).toEqual({
      completion: 0.2,
      furthestSlide: 10,
      lastSlide: 10,
      viewedSlides: 2,
    });
  });

  it('uses the final qualifying slide as last slide even when it is not the furthest', () => {
    // Given
    const slideOrdinals = [1, 6, 4];

    // When
    const summary = summarizeVisit(slideOrdinals, 8);

    // Then
    expect(summary.lastSlide).toBe(4);
    expect(summary.furthestSlide).toBe(6);
    expect(summary.completion).toBe(0.375);
  });
});

describe('trusted heartbeat intervals', () => {
  it('rejects just below the visibility threshold and accepts exactly 50 percent', () => {
    // Given
    const base = {
      previousAcceptedAt: new Date('2026-09-15T12:00:10.000Z'),
      eventAt: new Date('2026-09-15T12:00:15.000Z'),
      serverReceivedAt: new Date('2026-09-15T12:00:16.000Z'),
      tabVisible: true,
      recentlyActive: true,
    };

    // When / Then
    expect(deriveAcceptedInterval({ ...base, visibleRatio: 0.49 })).toBe(0);
    expect(deriveAcceptedInterval({ ...base, visibleRatio: 0.5 })).toBe(5_000);
  });

  it('caps an accepted active interval at the ten-second heartbeat ceiling', () => {
    // Given
    const input = {
      previousAcceptedAt: new Date('2026-09-15T12:00:00.000Z'),
      eventAt: new Date('2026-09-15T12:00:42.000Z'),
      serverReceivedAt: new Date('2026-09-15T12:00:43.000Z'),
      visibleRatio: 0.9,
      tabVisible: true,
      recentlyActive: true,
    };

    // When
    const interval = deriveAcceptedInterval(input);

    // Then
    expect(interval).toBe(10_000);
  });

  it('rejects background, idle, future, and out-of-order intervals', () => {
    // Given
    const base = {
      previousAcceptedAt: new Date('2026-09-15T12:00:10.000Z'),
      eventAt: new Date('2026-09-15T12:00:15.000Z'),
      serverReceivedAt: new Date('2026-09-15T12:00:16.000Z'),
      visibleRatio: 0.9,
      tabVisible: true,
      recentlyActive: true,
    };

    // When / Then
    expect(deriveAcceptedInterval({ ...base, tabVisible: false })).toBe(0);
    expect(deriveAcceptedInterval({ ...base, recentlyActive: false })).toBe(0);
    expect(deriveAcceptedInterval({ ...base, visibleRatio: 0.49 })).toBe(0);
    expect(deriveAcceptedInterval({ ...base, eventAt: new Date('2026-09-15T12:00:09.000Z') })).toBe(
      0,
    );
    expect(deriveAcceptedInterval({ ...base, eventAt: new Date('2026-09-15T12:02:00.000Z') })).toBe(
      0,
    );
  });
});
