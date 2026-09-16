import { html, type TemplateResult } from 'lit';
import type { DeckListItem } from './deck-types.ts';

export function renderDeckTable(decks: readonly DeckListItem[]): TemplateResult {
  if (decks.length === 0) {
    return html`<section class="surface empty">
      <h2>No pages in this view</h2>
      <p class="muted">
        Use <span class="mono">write</span> to create a durable presentation page, or change the
        filters above.
      </p>
    </section>`;
  }
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Page</th>
          <th>Owner</th>
          <th>Sender</th>
          <th>Status</th>
          <th>Access</th>
          <th>Links</th>
          <th>Viewers</th>
          <th>Last viewed</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        ${decks.map(renderDeckRow)}
      </tbody>
    </table>
  </div>`;
}

function renderDeckRow(deck: DeckListItem): TemplateResult {
  return html`<tr>
    <td data-label="Page">
      <a class="primary-link" href=${`/pages/${deck.id}`}>${deck.title}</a>
    </td>
    <td data-label="Owner">${deck.ownerEmail}</td>
    <td data-label="Sender">${deck.latestSenderEmail ?? '—'}</td>
    <td data-label="Status"><span class=${`badge ${deck.status}`}>${deck.status}</span></td>
    <td data-label="Access">${accessLabel(deck.accessMode)}</td>
    <td data-label="Links" class="mono">${deck.linkCount}</td>
    <td data-label="Viewers" class="mono">${deck.uniqueViewers ?? 'Withheld'}</td>
    <td data-label="Last viewed">
      ${deck.uniqueViewers === null ? 'Withheld' : formatDate(deck.lastViewed)}
    </td>
    <td data-label="Updated">${formatDate(deck.updatedAt)}</td>
  </tr>`;
}

function accessLabel(mode: DeckListItem['accessMode']): string {
  if (mode === 'allowed_email') return 'Allowed email';
  if (mode === 'authenticated') return 'Authenticated';
  if (mode === 'anyone') return 'Anyone';
  return 'Not shared';
}

function formatDate(value: string | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}
