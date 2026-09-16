import { html, type TemplateResult } from 'lit';
import type { DeckListItem } from './deck-types.ts';

type LibraryFiltersInput = {
  readonly query: string;
  readonly scope: 'mine' | 'shared' | 'team';
  readonly status: '' | 'active' | 'archived' | 'expired' | 'revoked';
  readonly ownerId: string;
  readonly senderId: string;
  readonly options: readonly DeckListItem[];
  readonly onSubmit: (event: Event) => void;
  readonly onQuery: (event: Event) => void;
  readonly onScope: (event: Event) => void;
  readonly onStatus: (event: Event) => void;
  readonly onOwner: (event: Event) => void;
  readonly onSender: (event: Event) => void;
};

export function renderLibraryFilters(input: LibraryFiltersInput): TemplateResult {
  return html`<form class="toolbar" @submit=${input.onSubmit} aria-label="Filter pages">
    <div class="field">
      <label for="deck-search">Search</label>
      <input
        id="deck-search"
        type="search"
        placeholder="Page or client"
        .value=${input.query}
        @input=${input.onQuery}
      />
    </div>
    <div class="field">
      <label for="deck-scope">Collection</label>
      <select id="deck-scope" .value=${input.scope} @change=${input.onScope}>
        <option value="mine">Mine</option>
        <option value="shared">Shared with me</option>
        <option value="team">Team / workspace</option>
      </select>
    </div>
    <div class="field">
      <label for="deck-owner">Owner</label>
      <select id="deck-owner" .value=${input.ownerId} @change=${input.onOwner}>
        <option value="">All owners</option>
        ${uniquePeople(input.options, 'owner').map(
          ([id, email]) => html`<option value=${id}>${email}</option>`,
        )}
      </select>
    </div>
    <div class="field">
      <label for="deck-sender">Sender</label>
      <select id="deck-sender" .value=${input.senderId} @change=${input.onSender}>
        <option value="">All senders</option>
        ${uniquePeople(input.options, 'sender').map(
          ([id, email]) => html`<option value=${id}>${email}</option>`,
        )}
      </select>
    </div>
    <div class="field">
      <label for="deck-status">Status</label>
      <select id="deck-status" .value=${input.status} @change=${input.onStatus}>
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="archived">Archived</option>
        <option value="expired">Expired links</option>
        <option value="revoked">Revoked links</option>
      </select>
    </div>
    <button class="button" type="submit">Apply filters</button>
  </form>`;
}

function uniquePeople(
  decks: readonly DeckListItem[],
  role: 'owner' | 'sender',
): readonly (readonly [string, string])[] {
  const people = new Map<string, string>();
  for (const deck of decks) {
    const id = role === 'owner' ? deck.ownerId : deck.latestSenderId;
    const email = role === 'owner' ? deck.ownerEmail : deck.latestSenderEmail;
    if (id !== null && email !== null) people.set(id, email);
  }
  return [...people.entries()].sort((left, right) => left[1].localeCompare(right[1]));
}
