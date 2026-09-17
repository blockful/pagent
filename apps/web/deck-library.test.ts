// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import './product-navigation.ts';
import './deck-library.ts';

const OWNER_ID = '9ea46b4d-58ae-4cdf-8de8-e41c255e628d';
const DECK_ID = '13d26c02-a80c-4b56-b1fa-1a91642684bf';
const SHARED_DECK_ID = '583c0ac4-5832-44a0-a13b-688b044b0208';

describe('deck-library', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('replaces its loading state with the fetched deck list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/auth/me')) {
          return Response.json({
            id: OWNER_ID,
            handle: null,
            email: 'owner@pagent.test',
            name: null,
            avatar_url: null,
          });
        }
        return Response.json({
          decks: [
            {
              id: DECK_ID,
              title: 'Northstar renewal',
              ownerId: OWNER_ID,
              ownerEmail: 'owner@pagent.test',
              latestSenderId: OWNER_ID,
              latestSenderEmail: 'owner@pagent.test',
              status: 'active',
              accessMode: 'anyone',
              linkCount: 1,
              uniqueViewers: 2,
              lastViewed: '2026-09-16T01:00:00.000Z',
              updatedAt: '2026-09-16T01:00:00.000Z',
            },
            {
              id: SHARED_DECK_ID,
              title: 'Shared without analytics',
              ownerId: OWNER_ID,
              ownerEmail: 'owner@pagent.test',
              latestSenderId: OWNER_ID,
              latestSenderEmail: 'owner@pagent.test',
              status: 'active',
              accessMode: 'authenticated',
              linkCount: 1,
              uniqueViewers: null,
              lastViewed: null,
              updatedAt: '2026-09-16T01:00:00.000Z',
            },
          ],
        });
      }),
    );

    const library = document.createElement('deck-library');
    document.body.append(library);

    await vi.waitFor(() => {
      expect(library.shadowRoot?.querySelector('a.primary-link')?.textContent).toContain(
        'Northstar renewal',
      );
    });
    expect(library.shadowRoot?.querySelector('a.primary-link')?.getAttribute('href')).toBe(
      `/pages/${DECK_ID}`,
    );
    expect(library.shadowRoot?.textContent).toContain('Pages');
    const accessHeader = library.shadowRoot?.querySelector('th:nth-child(5)')?.textContent?.trim();
    const accessCell = library.shadowRoot?.querySelector('tbody td:nth-child(5)');
    expect(accessHeader).toBeTruthy();
    expect(accessCell?.getAttribute('data-label')).toBe(accessHeader);
    expect(
      Array.from(library.shadowRoot?.querySelectorAll('[data-label="Viewers"]') ?? []).map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(['2', 'Withheld']);
    expect(
      Array.from(library.shadowRoot?.querySelectorAll('[data-label="Last viewed"]') ?? []).map(
        (cell) => cell.textContent?.trim(),
      ),
    ).toEqual([expect.not.stringContaining('Withheld'), 'Withheld']);
    expect(library.shadowRoot?.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
