// @vitest-environment happy-dom

import { html, render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { isSpecificAudience, renderSharingPanel } from './deck-sharing-view.ts';
import type { AccessRequest, ShareLink } from './deck-types.ts';

const link: ShareLink = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Prospects',
  creatorId: '00000000-0000-4000-8000-000000000002',
  creatorEmail: 'owner@example.com',
  accessMode: 'anyone',
  allowedEmails: [],
  allowedDomains: [],
  expiresAt: null,
  revokedAt: null,
  visitCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const request: AccessRequest = {
  id: '00000000-0000-4000-8000-000000000003',
  requestedEmail: 'viewer@example.com',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('isSpecificAudience', () => {
  it('defaults a new share link to Anyone', () => {
    expect(isSpecificAudience(null)).toBe(false);
  });

  it('keeps an existing restricted link on the specific-audience option', () => {
    expect(isSpecificAudience({ accessMode: 'allowed_email' })).toBe(true);
    expect(isSpecificAudience({ accessMode: 'authenticated' })).toBe(true);
  });

  it('shows bounded owner action states and a confirmation before revoking a link', () => {
    const container = document.createElement('div');

    render(
      html`${renderSharingPanel({
        links: [link],
        requests: [request],
        requestLinkId: link.id,
        editing: null,
        loading: false,
        saving: false,
        error: 'Could not load access requests',
        createdUrl: null,
        revokeCandidate: link,
        revoking: true,
        previewingLinkId: link.id,
        requestsLoading: true,
        decidingRequestId: request.id,
        onOpenEditor: vi.fn(),
        onCloseEditor: vi.fn(),
        onSaveLink: vi.fn(),
        onOpenRevoke: vi.fn(),
        onCloseRevoke: vi.fn(),
        onConfirmRevoke: vi.fn(),
        onPreview: vi.fn(),
        onShowRequests: vi.fn(),
        onDecide: vi.fn(),
        onCopyCreated: vi.fn(),
      })}`,
      container,
    );

    const preview = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Opening…',
    );
    const requests = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Loading requests…',
    );
    const dialogButtons = Array.from(
      container.querySelector('#revoke-dialog')?.querySelectorAll('button') ?? [],
    );

    expect(preview?.disabled).toBe(true);
    expect(preview?.getAttribute('aria-busy')).toBe('true');
    expect(requests?.disabled).toBe(true);
    expect(
      Array.from(container.querySelectorAll('[aria-busy="true"]')).some((element) =>
        element.textContent?.includes('Loading access requests'),
      ),
    ).toBe(true);
    expect(dialogButtons.every((button) => button.disabled)).toBe(true);
    expect(dialogButtons[1]?.textContent?.trim()).toBe('Revoking…');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load access requests',
    );
  });

  it('retains a revoke failure in the confirmation dialog after its busy state ends', () => {
    const container = document.createElement('div');

    render(
      html`${renderSharingPanel({
        links: [link],
        requests: [],
        requestLinkId: null,
        editing: null,
        loading: false,
        saving: false,
        error: 'Could not revoke link',
        createdUrl: null,
        revokeCandidate: link,
        revoking: false,
        previewingLinkId: null,
        requestsLoading: false,
        decidingRequestId: null,
        onOpenEditor: vi.fn(),
        onCloseEditor: vi.fn(),
        onSaveLink: vi.fn(),
        onOpenRevoke: vi.fn(),
        onCloseRevoke: vi.fn(),
        onConfirmRevoke: vi.fn(),
        onPreview: vi.fn(),
        onShowRequests: vi.fn(),
        onDecide: vi.fn(),
        onCopyCreated: vi.fn(),
      })}`,
      container,
    );

    const dialog = container.querySelector('#revoke-dialog');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain('Could not revoke link');
    expect(dialog?.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });
});
