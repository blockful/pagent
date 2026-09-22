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
import { renderFilters, type AnalyticsFiltersInput } from './deck-analytics-filters-view.ts';

export type AnalyticsView = 'overview' | 'visitors' | 'slides';

type AnalyticsViewInput = AnalyticsFiltersInput & {
  readonly current: DeckAnalytics | null;
  readonly view: AnalyticsView;
  readonly error: string | null;
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
      )}${metric(
        'Average active time',
        duration(overview.averageActiveTimeMs),
      )}${overview.averageCompletion === null
        ? nothing
        : metric('Average completion', percent(overview.averageCompletion))}${metric(
        'Last viewed',
        dateTime(overview.lastViewed),
      )}
    </section>
    ${overview.totalVisits === 0
      ? html`<section class="surface empty">
          <h2>No human visits yet</h2>
          <p class="muted">
            A visit appears after a visible, interactive viewer session. Link previews and owner
            previews stay excluded.
          </p>
        </section>`
      : analytics.contentFormat === 'html'
        ? html`<p class="notice">
            HTML pages report visits and active time. Their layout and navigation belong to the
            author; slide completion is not inferred.
          </p>`
        : html`<section class="surface stack">
            <p class="eyebrow">Top slide</p>
            <h2>${overview.topSlide?.title ?? `Slide ${overview.topSlide?.ordinal ?? '—'}`}</h2>
            <p class="muted">
              Highest total active time in the selected scope. Engagement signals describe
              attention, not purchase intent.
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
  const showCompletion = analytics?.contentFormat !== 'html';
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
          ${showCompletion ? html`<th>Max completion</th>` : nothing}
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
              ${showCompletion
                ? html`<td data-label="Max completion">${percent(visitor.maximumCompletion)}</td>`
                : nothing}
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
  const showSlides = analytics.contentFormat !== 'html';
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Viewer</th>
          <th>Sender</th>
          <th>${showSlides ? 'Sequence' : 'Document'}</th>
          <th>Active</th>
          ${showSlides
            ? html`<th>Completion</th>
                <th>Furthest</th>
                <th>Last</th>`
            : nothing}
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
              <td data-label=${showSlides ? 'Sequence' : 'Document'}>${visitSequence(visit)}</td>
              <td data-label="Active">${duration(visit.totalActiveTimeMs)}</td>
              ${showSlides
                ? html`<td data-label="Completion">${percent(visit.completion)}</td>
                    <td data-label="Furthest">${visit.furthestSlide ?? '—'}</td>
                    <td data-label="Last">${visit.lastSlide ?? '—'}</td>`
                : nothing}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}
