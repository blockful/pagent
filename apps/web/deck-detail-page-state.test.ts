import { describe, expect, it } from 'vitest';
import {
  availableDeckDetailTabs,
  createDeckDetailPageState,
  tabFromHash,
} from './deck-detail-page-state.ts';

describe('deck detail page state', () => {
  it('uses preview for an unknown initial hash', () => {
    const state = createDeckDetailPageState('#not-a-tab');

    expect(state.activeTab).toBe('preview');
    expect(state.loading).toBe(true);
    expect(state.mutation).toBeNull();
  });

  it('accepts a known hash and exposes only permitted tabs', () => {
    const activeTab = tabFromHash('#links');
    const viewerTabs = availableDeckDetailTabs(false, false);
    const ownerAnalyticsTabs = availableDeckDetailTabs(true, true);

    expect(activeTab).toBe('links');
    expect(viewerTabs).toEqual(['preview']);
    expect(ownerAnalyticsTabs).toEqual([
      'preview',
      'overview',
      'visitors',
      'slides',
      'links',
      'access',
    ]);
  });
});
