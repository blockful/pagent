import { html, type TemplateResult } from 'lit';
import type { DeckAnalytics } from './deck-types.ts';

export type AnalyticsFiltersInput = {
  readonly base: DeckAnalytics | null;
  readonly filtering: boolean;
  readonly onApply: (event: Event) => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
};

export function renderFilters(input: AnalyticsFiltersInput): TemplateResult {
  const links = uniqueOptions(
    (input.base?.visits ?? []).map((visit) => [visit.linkId, visit.linkName]),
  );
  const senders = uniqueOptions(
    (input.base?.visits ?? []).map((visit) => [visit.senderId, visit.senderEmail]),
  );
  const revisions = [
    ...new Set(
      input.base?.revisionNumbers ??
        (input.base?.slides ?? []).map((slide) => slide.revisionNumber),
    ),
  ].sort((a, b) => b - a);
  return html`<form
    class="toolbar"
    @submit=${input.onApply}
    aria-label="Filter engagement analytics"
  >
    <div class="field">
      <label for="analytics-from">From</label><input id="analytics-from" name="from" type="date" />
    </div>
    <div class="field">
      <label for="analytics-to">To</label><input id="analytics-to" name="to" type="date" />
    </div>
    <div class="field">
      <label for="analytics-link">Link</label
      ><select id="analytics-link" name="link_id">
        <option value="">All links</option>
        ${links.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
      </select>
    </div>
    <div class="field">
      <label for="analytics-viewer">Viewer</label
      ><input id="analytics-viewer" name="viewer" type="search" placeholder="Email or Anonymous" />
    </div>
    <div class="field">
      <label for="analytics-sender">Sender</label
      ><select id="analytics-sender" name="sender">
        <option value="">All senders</option>
        ${senders.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
      </select>
    </div>
    <div class="field">
      <label for="analytics-revision">Revision</label
      ><select id="analytics-revision" name="revision">
        <option value="">All revisions</option>
        ${revisions.map(
          (revision) => html`<option value=${revision}>Revision ${revision}</option>`,
        )}
      </select>
    </div>
    <button class="button" type="submit" aria-busy=${String(input.filtering)}>Apply</button
    ><button class="button quiet" type="button" @click=${input.onClear}>Clear</button
    ><button class="button secondary" type="button" @click=${input.onExport}>Export CSV</button>
  </form>`;
}

function uniqueOptions(
  values: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  return [...new Map(values).entries()];
}
