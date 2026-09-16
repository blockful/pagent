import { html, type TemplateResult } from 'lit';
import { renderDeckPreview } from './deck-detail-preview-view.ts';
import type { DetailTab } from './deck-detail-page-state.ts';
import type { DeckAnalytics, DeckDetail, DeckPreview } from './deck-types.ts';

export type DeckDetailPanelInput = {
  readonly deckId: string;
  readonly detail: DeckDetail;
  readonly preview: DeckPreview | null;
  readonly analytics: DeckAnalytics | null;
  readonly previewIndex: number;
  readonly canManage: boolean;
  readonly renaming: boolean;
  readonly mutationError: string | null;
  readonly onMove: (delta: number) => void;
  readonly onRename: (event: Event) => void;
};

export function renderUnauthorizedDeckDetailPage(loginHref: string): TemplateResult {
  return html`<section class="shell">
    <main class="page">
      <div class="surface empty">
        <h1>Sign in to view this page.</h1>
        <a class="button" href=${loginHref}>Continue securely</a>
      </div>
    </main>
  </section>`;
}

export function renderLoadingDeckDetailPage(): TemplateResult {
  return html`<section class="shell">
    <main class="page">
      <div class="surface stack" aria-busy="true">
        ${[1, 2, 3, 4].map(() => html`<span class="loading-line"></span>`)}
      </div>
    </main>
  </section>`;
}

export function renderUnavailableDeckDetailPage(accessDenied: boolean): TemplateResult {
  return html`<section class="shell">
    <main class="page">
      <div class="surface empty" role="alert">
        <h1>${accessDenied ? 'You don’t have access to this page.' : 'Page unavailable.'}</h1>
        <p class="lede">
          ${accessDenied
            ? 'Content and analytics require an explicit workspace grant. Ask a workspace administrator for access.'
            : 'We couldn’t open this page. Return to Pages to choose another page or try again later.'}
        </p>
        <a class="button" href="/pages">Back to Pages</a>
      </div>
    </main>
  </section>`;
}

export function renderDeckDetailPanel(tab: DetailTab, input: DeckDetailPanelInput): TemplateResult {
  if (tab === 'preview')
    return renderDeckPreview({
      preview: input.preview,
      detail: input.detail,
      slideIndex: input.previewIndex,
      canManage: input.canManage,
      renaming: input.renaming,
      mutationError: input.mutationError,
      onMove: input.onMove,
      onRename: input.onRename,
    });
  if (tab === 'links')
    return html`<deck-sharing-panel .deckId=${input.deckId}></deck-sharing-panel>`;
  if (tab === 'access')
    return html`<deck-access-panel .deckId=${input.deckId}></deck-access-panel>`;
  return html`<deck-analytics-panel
    .analytics=${input.analytics}
    .deckId=${input.deckId}
    .view=${tab}
  ></deck-analytics-panel>`;
}
