// @vitest-environment happy-dom

import { html, render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import {
  renderDeckPreview,
  renderDeckTabs,
  renderDeleteDialog,
  renderLoadedDeckPage,
  type DetailTab,
} from './deck-detail-view.ts';
import type { DeckDetail } from './deck-types.ts';

const detail: DeckDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Quarterly review',
  description: null,
  clientLabel: null,
  status: 'active',
  ownerId: '00000000-0000-4000-8000-000000000002',
  ownerEmail: 'owner@example.com',
  analyticsVisibility: 'private',
  latestRevisionNumber: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastPublishedAt: '2026-01-01T00:00:00.000Z',
  revisions: [],
  recentActivity: [],
};

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

  it('shows a recoverable busy state while an owner rename or archive is pending', () => {
    const container = document.createElement('div');

    render(
      html`${renderDeckPreview({
        preview: null,
        detail,
        slideIndex: 0,
        canManage: true,
        renaming: true,
        mutationError: 'Could not save title',
        onMove: vi.fn(),
        onRename: vi.fn(),
      })}${renderLoadedDeckPage({
        user: null,
        detail,
        tabs: ['preview'],
        activeTab: 'preview',
        analyticsDenied: false,
        analyticsError: null,
        canManage: true,
        mutation: 'archive',
        mutationError: 'Could not archive page',
        panel: () => html``,
        onTab: vi.fn(),
        onTabKey: vi.fn(),
        onArchive: vi.fn(),
        onOpenDelete: vi.fn(),
        onCloseDelete: vi.fn(),
        onDelete: vi.fn(),
      })}`,
      container,
    );

    const title = container.querySelector<HTMLInputElement>('#deck-title');
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Saving title…',
    );
    const archive = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Archiving…',
    );

    expect(title?.disabled).toBe(true);
    expect(save?.disabled).toBe(true);
    expect(save?.getAttribute('aria-busy')).toBe('true');
    expect(archive?.disabled).toBe(true);
    expect(archive?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(3);
  });

  it('locks the destructive confirmation while deletion is pending', () => {
    const container = document.createElement('div');

    render(
      renderDeleteDialog({
        title: detail.title,
        deleting: true,
        mutationError: 'Could not delete page',
        onClose: vi.fn(),
        onDelete: vi.fn(),
      }),
      container,
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[1]?.textContent?.trim()).toBe('Deleting…');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not delete page',
    );
  });

  it('retains a delete failure inside the open confirmation after its busy state ends', () => {
    const container = document.createElement('div');

    render(
      renderDeleteDialog({
        title: detail.title,
        deleting: false,
        mutationError: 'Could not delete page',
        onClose: vi.fn(),
        onDelete: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not delete page',
    );
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });
});
