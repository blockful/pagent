import { html, nothing, type TemplateResult } from 'lit';
import {
  confidenceLabel,
  dateTime,
  duration,
  emptyAnalytics,
  metric,
  percent,
  visitSequence,
} from './analytics-format.ts';
import type { DeckAnalytics } from './deck-types.ts';

export type AnalyticsView = 'overview' | 'visitors' | 'slides';

type AnalyticsViewInput = {
  readonly base: DeckAnalytics | null;
  readonly current: DeckAnalytics | null;
  readonly view: AnalyticsView;
  readonly filtering: boolean;
  readonly error: string | null;
  readonly onApply: (event: Event) => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
};

export function renderAnalyticsPanel(input: AnalyticsViewInput): TemplateResult {
  if (input.base === null)
    return html`<section class="surface empty">Analytics unavailable.</section>`;
  return html`<div class="stack">
    ${renderFilters(input)}
    ${input.error ? html`<p class="notice error" role="alert">${input.error}</p>` : nothing}
    ${renderCurrentView(input.current, input.view)}
  </div>`;
}

function renderFilters(input: AnalyticsViewInput): TemplateResult {
  const links = uniqueOptions(
    (input.base?.visits ?? []).map((visit) => [visit.linkId, visit.linkName]),
  );
  const senders = uniqueOptions(
    (input.base?.visits ?? []).map((visit) => [visit.senderId, visit.senderEmail]),
  );
  const revisions = [
    ...new Set((input.base?.slides ?? []).map((slide) => slide.revisionNumber)),
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

function renderCurrentView(analytics: DeckAnalytics | null, view: AnalyticsView): TemplateResult {
  if (view === 'visitors') return renderVisitors(analytics);
  if (view === 'slides') return renderSlides(analytics);
  return renderOverview(analytics);
}

function renderOverview(analytics: DeckAnalytics | null): TemplateResult {
  if (analytics === null) return html``;
  const overview = analytics.overview;
  return html`<div class="stack">
    <section class="metric-grid" aria-label="Page engagement overview">
      ${metric('Visits', overview.totalVisits)}${metric(
        'Unique viewers',
        overview.uniqueViewers,
      )}${metric('Average active time', duration(overview.averageActiveTimeMs))}${metric(
        'Average completion',
        percent(overview.averageCompletion),
      )}${metric('Last viewed', dateTime(overview.lastViewed))}
    </section>
    ${overview.totalVisits === 0
      ? html`<section class="surface empty">
          <h2>No human visits yet</h2>
          <p class="muted">
            A visit appears after a visible, interactive viewer session. Link previews and owner
            previews stay excluded.
          </p>
        </section>`
      : html`<section class="surface stack">
          <p class="eyebrow">Top slide</p>
          <h2>${overview.topSlide?.title ?? `Slide ${overview.topSlide?.ordinal ?? '—'}`}</h2>
          <p class="muted">
            Highest total active time in the selected scope. Engagement signals describe attention,
            not purchase intent.
          </p>
        </section>`}
    ${analytics.visits.length
      ? html`<section class="surface stack">
          <h2>Recent visits</h2>
          ${renderVisitTable(analytics)}
        </section>`
      : nothing}
  </div>`;
}

function renderVisitors(analytics: DeckAnalytics | null): TemplateResult {
  const visitors = analytics?.visitors ?? [];
  if (visitors.length === 0)
    return emptyAnalytics(
      'No visitors yet',
      'Known emails and Anonymous viewers will appear after a real visit.',
    );
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Viewer</th>
          <th>Confidence</th>
          <th>First visit</th>
          <th>Last visit</th>
          <th>Visits</th>
          <th>Active time</th>
          <th>Max completion</th>
        </tr>
      </thead>
      <tbody>
        ${visitors.map(
          (visitor) =>
            html`<tr>
              <td data-label="Viewer">${visitor.viewer}</td>
              <td data-label="Confidence">
                <span class=${`badge ${visitor.identityConfidence}`}
                  >${confidenceLabel(visitor.identityConfidence)}</span
                >
              </td>
              <td data-label="First visit">${dateTime(visitor.firstVisit)}</td>
              <td data-label="Last visit">${dateTime(visitor.lastVisit)}</td>
              <td data-label="Visits" class="mono">${visitor.visits}</td>
              <td data-label="Active time">${duration(visitor.totalActiveTimeMs)}</td>
              <td data-label="Max completion">${percent(visitor.maximumCompletion)}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function renderSlides(analytics: DeckAnalytics | null): TemplateResult {
  const slides = analytics?.slides ?? [];
  if (slides.length === 0)
    return emptyAnalytics(
      'No slide data yet',
      'Per-slide attention appears after qualifying views of at least one second.',
    );
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Slide</th>
          <th>Revision</th>
          <th>Viewers</th>
          <th>View rate</th>
          <th>Avg active</th>
          <th>Total active</th>
          <th>Exits</th>
        </tr>
      </thead>
      <tbody>
        ${slides.map(
          (slide) =>
            html`<tr>
              <td data-label="Slide">
                <strong>${slide.ordinal}. ${slide.title ?? slide.stableSlideId}</strong>
              </td>
              <td data-label="Revision" class="mono">r${slide.revisionNumber}</td>
              <td data-label="Viewers" class="mono">${slide.uniqueViewers}</td>
              <td data-label="View rate">${percent(slide.viewRate)}</td>
              <td data-label="Avg active">${duration(slide.averageActiveTimeMs)}</td>
              <td data-label="Total active">${duration(slide.totalActiveTimeMs)}</td>
              <td data-label="Exits" class="mono">${slide.exits}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function renderVisitTable(analytics: DeckAnalytics): TemplateResult {
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Viewer</th>
          <th>Sender</th>
          <th>Sequence</th>
          <th>Active</th>
          <th>Completion</th>
          <th>Furthest</th>
          <th>Last</th>
        </tr>
      </thead>
      <tbody>
        ${analytics.visits.map(
          (visit) =>
            html`<tr>
              <td data-label="Viewer">
                ${visit.viewer}<br /><span class=${`badge ${visit.identityConfidence}`}
                  >${confidenceLabel(visit.identityConfidence)}</span
                >
              </td>
              <td data-label="Sender">
                ${visit.senderEmail}<br /><span class="caption">${visit.linkName}</span>
              </td>
              <td data-label="Sequence" class="mono">${visitSequence(visit)}</td>
              <td data-label="Active">${duration(visit.totalActiveTimeMs)}</td>
              <td data-label="Completion">${percent(visit.completion)}</td>
              <td data-label="Furthest">${visit.furthestSlide ?? '—'}</td>
              <td data-label="Last">${visit.lastSlide ?? '—'}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function uniqueOptions(
  values: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  return [...new Map(values).entries()];
}
