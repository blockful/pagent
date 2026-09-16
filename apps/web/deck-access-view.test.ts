// @vitest-environment happy-dom

import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { renderAccessPanel } from './deck-access-view.ts';

describe('renderAccessPanel', () => {
  it('keeps page permissions local and sends workspace governance to Admin', () => {
    const container = document.createElement('div');
    const noop = vi.fn();

    render(
      renderAccessPanel({
        settings: {
          analyticsVisibility: 'private',
          analyticsConsentRequired: false,
          analyticsRetentionDays: 365,
          members: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              email: 'owner@example.com',
              handle: 'owner',
              role: 'owner',
              status: 'active',
              canViewContent: true,
              selectedForAnalytics: false,
            },
            {
              id: '00000000-0000-4000-8000-000000000002',
              email: 'member@example.com',
              handle: 'member',
              role: 'member',
              status: 'active',
              canViewContent: false,
              selectedForAnalytics: false,
            },
          ],
          teams: [],
        },
        visibility: 'private',
        subjectIds: [],
        contentIds: [],
        audience: null,
        loading: false,
        saving: null,
        error: null,
        message: null,
        onVisibilityChange: noop,
        onToggleSubject: noop,
        onToggleContent: noop,
        onPreviewAudience: noop,
        onSaveAudience: noop,
        onSaveContent: noop,
      }),
      container,
    );

    expect(container.textContent).toContain('View page content');
    expect(container.textContent).toContain('View analytics');
    expect(container.textContent).toContain('member@example.com');
    expect(container.textContent).not.toContain('Add workspace member');
    expect(container.textContent).not.toContain('Privacy & retention');
    expect(container.textContent).not.toContain('Audit log');
  });
});
