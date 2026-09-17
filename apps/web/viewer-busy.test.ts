// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ json: vi.fn() }));

vi.mock('./deck-api.ts', () => ({
  ApiError: class ApiError extends Error {},
  apiJson: api.json,
  loginUrl: () => '/login',
}));

import './deck-viewer.ts';

type ViewerFixture = {
  readonly state: 'gate' | 'unavailable' | 'pending';
  readonly accessMode: 'anyone' | 'allowed_email';
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason),
  };
}

function mountViewer(fixture: ViewerFixture): HTMLElement {
  const viewer = document.createElement('deck-viewer');
  document.body.append(viewer);
  Reflect.set(viewer, 'shareToken', 'share-token');
  Reflect.set(viewer, 'metadata', {
    deckTitle: 'Planning page',
    senderEmail: 'owner@example.com',
    accessMode: fixture.accessMode,
    analyticsConsentRequired: true,
    linkId: 'link-1',
    linkName: 'Planning',
    state: 'active',
  });
  Reflect.set(viewer, 'state', fixture.state);
  return viewer;
}

function shadowButton(viewer: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(viewer.shadowRoot?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${label} button`);
  return button;
}

function shadowForm(viewer: HTMLElement): HTMLFormElement {
  const form = viewer.shadowRoot?.querySelector('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Missing viewer form');
  return form;
}

describe('DeckViewer busy access actions', () => {
  beforeEach(() => {
    api.json.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('Given an anyone viewer gate, when Open presentation is clicked twice before access resolves, then it sends one access request and locks gate controls', async () => {
    const access = deferred<{ readonly kind: 'unavailable' }>();
    api.json.mockReturnValueOnce(access.promise);
    const viewer = mountViewer({ state: 'gate', accessMode: 'anyone' });
    await vi.waitFor(() => expect(viewer.shadowRoot?.querySelector('button')).not.toBeNull());

    const open = shadowButton(viewer, 'Open presentation');
    const idleLabel = open.textContent;
    open.click();
    open.click();

    expect(api.json).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(open.disabled).toBe(true));
    expect(open.getAttribute('aria-busy')).toBe('true');
    expect(open.textContent).not.toBe(idleLabel);
    expect(
      viewer.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
    ).toBe(true);

    access.resolve({ kind: 'unavailable' });
    await vi.waitFor(() => expect(Reflect.get(viewer, 'submitting')).toBe(false));
  });

  it('Given an allowed-email viewer gate, when its form is submitted twice before access resolves, then it sends one email access request', async () => {
    const access = deferred<{ readonly kind: 'unavailable' }>();
    api.json.mockReturnValueOnce(access.promise);
    const viewer = mountViewer({ state: 'gate', accessMode: 'allowed_email' });
    await vi.waitFor(() => expect(viewer.shadowRoot?.querySelector('form')).not.toBeNull());

    const form = shadowForm(viewer);
    const submit = shadowButton(viewer, 'Continue');
    const idleLabel = submit.textContent;
    const email = form.querySelector<HTMLInputElement>('input[name="email"]');
    if (email === null) throw new Error('Missing email input');
    email.value = 'viewer@example.com';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(api.json).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(email.disabled).toBe(true));
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).not.toBe(idleLabel);

    access.resolve({ kind: 'unavailable' });
    await vi.waitFor(() => expect(Reflect.get(viewer, 'submitting')).toBe(false));
  });

  it('Given an unavailable viewer gate, when Request access is submitted twice before approval creation resolves, then it sends one approval request and locks the form', async () => {
    const approval = deferred<{ readonly requestId: string }>();
    api.json.mockReturnValueOnce(approval.promise);
    const viewer = mountViewer({ state: 'unavailable', accessMode: 'allowed_email' });
    await vi.waitFor(() => expect(viewer.shadowRoot?.querySelector('form')).not.toBeNull());

    const form = shadowForm(viewer);
    const submit = shadowButton(viewer, 'Request access');
    const idleLabel = submit.textContent;
    const email = form.querySelector<HTMLInputElement>('input[name="email"]');
    if (email === null) throw new Error('Missing request email input');
    email.value = 'viewer@example.com';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(api.json).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(email.disabled).toBe(true));
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(submit.textContent).not.toBe(idleLabel);

    approval.resolve({ requestId: 'request-1' });
    await vi.waitFor(() => expect(Reflect.get(viewer, 'submitting')).toBe(false));
  });

  it('Given a pending approval request, when Check status is clicked twice before the status resolves, then it sends one status request', async () => {
    const status = deferred<{ readonly status: 'pending' }>();
    api.json.mockReturnValueOnce(status.promise);
    sessionStorage.setItem('pagent-access-request:share-token', 'request-1');
    const viewer = mountViewer({ state: 'pending', accessMode: 'allowed_email' });
    await vi.waitFor(() => expect(viewer.shadowRoot?.querySelector('button')).not.toBeNull());

    const check = shadowButton(viewer, 'Check status');
    const idleLabel = check.textContent;
    check.click();
    check.click();

    expect(api.json).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(check.disabled).toBe(true));
    expect(check.getAttribute('aria-busy')).toBe('true');
    expect(check.textContent).not.toBe(idleLabel);

    status.resolve({ status: 'pending' });
    await vi.waitFor(() => expect(Reflect.get(viewer, 'submitting')).toBe(false));
  });

  it('Given an unavailable viewer gate, when the approval request fails, then it announces the human-readable failure and unlocks the action', async () => {
    api.json.mockRejectedValueOnce(new Error('Request service is temporarily unavailable'));
    const viewer = mountViewer({ state: 'unavailable', accessMode: 'allowed_email' });
    await vi.waitFor(() => expect(viewer.shadowRoot?.querySelector('form')).not.toBeNull());

    const form = shadowForm(viewer);
    const email = form.querySelector<HTMLInputElement>('input[name="email"]');
    if (email === null) throw new Error('Missing request email input');
    email.value = 'viewer@example.com';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(viewer.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
        'Request service is temporarily unavailable',
      ),
    );
    const alert = viewer.shadowRoot?.querySelector('[role="alert"]');
    expect(alert?.getAttribute('tabindex')).toBe('-1');
    await vi.waitFor(() => expect(viewer.shadowRoot?.activeElement).toBe(alert));
    expect(Reflect.get(viewer, 'submitting')).toBe(false);
  });

  it('Given a pending approval request, when the status check fails, then it announces the human-readable failure and unlocks the action', async () => {
    api.json.mockRejectedValueOnce(new Error('Status service is temporarily unavailable'));
    sessionStorage.setItem('pagent-access-request:share-token', 'request-1');
    const viewer = mountViewer({ state: 'pending', accessMode: 'allowed_email' });
    await vi.waitFor(() => expect(viewer.shadowRoot?.querySelector('button')).not.toBeNull());

    shadowButton(viewer, 'Check status').click();

    await vi.waitFor(() =>
      expect(viewer.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
        'Status service is temporarily unavailable',
      ),
    );
    await vi.waitFor(() =>
      expect(viewer.shadowRoot?.activeElement).toBe(
        viewer.shadowRoot?.querySelector('[role="alert"]'),
      ),
    );
    expect(Reflect.get(viewer, 'submitting')).toBe(false);
  });

  it('moves focus to the error when an owner preview session is missing', async () => {
    const viewer = document.createElement('deck-viewer');
    document.body.append(viewer);

    await vi.waitFor(() =>
      expect(viewer.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull(),
    );
    expect(viewer.shadowRoot?.activeElement).toBe(
      viewer.shadowRoot?.querySelector('[role="alert"]'),
    );
  });
});
