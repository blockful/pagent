// @vitest-environment happy-dom

import { html, render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { renderDeckTabs, type DetailTab } from './deck-detail-view.ts';

describe('renderDeckTabs', () => {
  it('keeps every tabpanel mounted with a complete ARIA relationship', () => {
    const tabs: readonly DetailTab[] = ['preview', 'overview', 'links', 'access'];
    const container = document.createElement('div');

    render(
      renderDeckTabs({
        tabs,
        activeTab: 'overview',
        panel: (tab) => html`<span>${tab}</span>`,
        onTab: vi.fn(),
        onTabKey: vi.fn(),
      }),
      container,
    );

    for (const tab of tabs) {
      const control = container.querySelector(`#deck-tab-${tab}`);
      const panel = container.querySelector(`#deck-panel-${tab}`);
      expect(control?.getAttribute('aria-controls')).toBe(`deck-panel-${tab}`);
      expect(panel?.getAttribute('aria-labelledby')).toBe(`deck-tab-${tab}`);
      expect(panel?.hasAttribute('hidden')).toBe(tab !== 'overview');
      expect(panel?.textContent?.trim()).toBe(tab);
    }
  });
});
