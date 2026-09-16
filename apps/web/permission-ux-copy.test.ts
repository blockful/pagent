// @vitest-environment happy-dom

import { html, render } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ empty: vi.fn(), json: vi.fn() }));

vi.mock('./deck-api.ts', () => {
  class ApiError extends Error {
    readonly status: number;

    constructor(status: number, _code: string | undefined, message: string) {
      super(message);
      this.status = status;
    }
  }

  return {
    ApiError,
    apiEmpty: api.empty,
    apiJson: api.json,
    loginUrl: () => '/login',
  };
});

import { ApiError } from './deck-api.ts';
import './deck-detail.ts';
import { renderViewerGate } from './viewer-gate.ts';

afterEach(() => {
  api.empty.mockReset();
  api.json.mockReset();
  document.body.replaceChildren();
});

function renderGate(state: 'loading' | 'pending' | 'error' | 'gate'): HTMLDivElement {
  const container = document.createElement('div');
  render(
    html`${renderViewerGate({
      state,
      metadata:
        state === 'gate'
          ? {
              deckTitle: 'Planning page',
              senderEmail: 'owner@example.com',
              accessMode: 'anyone',
              analyticsConsentRequired: false,
              linkId: 'link-1',
              linkName: 'Planning',
              state: 'active',
            }
          : null,
      message: state === 'error' ? 'Temporary failure' : null,
      consent: false,
      submitting: false,
      loginHref: '/login',
      onCheckRequest: vi.fn(),
      onRequestAccess: vi.fn(),
      onRequestApproval: vi.fn(),
      onSubmitEmail: vi.fn(),
      onConsentChange: vi.fn(),
    })}`,
    container,
  );
  return container;
}

describe('permission UX copy', () => {
  it('Given a detail API 403, when the page loads, then it settles on the workspace-grant recovery state', async () => {
    api.json.mockRejectedValue(new ApiError(403, undefined, 'Request failed (403)'));
    const page = Object.assign(document.createElement('deck-detail-page'), { deckId: 'page-1' });
    document.body.append(page);

    await vi.waitFor(() =>
      expect(page.shadowRoot?.textContent).toContain('You don’t have access to this page'),
    );

    expect(page.shadowRoot?.textContent).toContain(
      'Content and analytics require an explicit workspace grant',
    );
    expect(page.shadowRoot?.textContent).not.toContain('Request failed (403)');
    expect(page.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
      'You don’t have access to this page',
    );
    expect(page.shadowRoot?.querySelector('a')?.getAttribute('href')).toBe('/pages');
  });

  it('Given an unavailable detail page, when it renders, then it offers a clear Pages recovery action', async () => {
    api.json.mockRejectedValue(new ApiError(503, undefined, 'Request failed (503)'));
    const page = Object.assign(document.createElement('deck-detail-page'), { deckId: 'page-2' });
    document.body.append(page);

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('Page unavailable'));

    expect(page.shadowRoot?.querySelector('a')?.textContent?.trim()).toBe('Back to Pages');
  });

  it('Given a viewer gate, when the viewer is loading, then it uses Page terminology', () => {
    const container = renderGate('loading');

    expect(container.textContent).toContain('Loading page…');
  });

  it('Given a pending viewer request, when the gate renders, then it uses presentation terminology', () => {
    const container = renderGate('pending');

    expect(container.textContent).toContain('No presentation content is shown');
  });

  it('Given a viewer error, when the gate renders, then it names the Page outcome', () => {
    const container = renderGate('error');

    expect(container.textContent).toContain('Could not open page');
  });

  it('Given an anyone-link viewer gate, when it is ready to open, then it uses presentation wording', () => {
    const container = renderGate('gate');

    expect(container.querySelector('button')?.textContent?.trim()).toBe('Open presentation');
    expect(container.textContent).toMatch(/after the\s+presentation is\s+visible/);
  });
});
