// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import './deck-sharing-panel.ts';

const DECK_ID = '00000000-0000-4000-8000-000000000001';

type DeferredResponse = {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
};

describe('deck-sharing-panel', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('Given a pending save, when submitted again, then it sends one create request', async () => {
    // Given
    const createResponse = deferredResponse();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          input.toString().endsWith(`/v1/decks/${DECK_ID}/share-links`) &&
          init?.method === 'POST'
        ) {
          return createResponse.promise;
        }
        return Response.json({ links: [] });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const panel = Object.assign(document.createElement('deck-sharing-panel'), { deckId: DECK_ID });
    document.body.append(panel);
    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector('form')).not.toBeNull());
    const form = panel.shadowRoot?.querySelector<HTMLFormElement>('#link-dialog form');
    if (form === null || form === undefined) throw new TypeError('Missing share-link editor form');

    // When
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: true }));

    // Then
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) =>
            input.toString().endsWith(`/v1/decks/${DECK_ID}/share-links`) &&
            init?.method === 'POST',
        ),
      ).toHaveLength(1);
    });
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    createResponse.resolve(
      Response.json({
        id: '00000000-0000-4000-8000-000000000002',
        token: 'share-token',
        accessMode: 'anyone',
        expiresAt: null,
      }),
    );
    await vi.waitFor(() => expect(panel.shadowRoot?.textContent).toContain('Link ready.'));
  });
});

function deferredResponse(): DeferredResponse {
  let resolve = (_response: Response): void => undefined;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
