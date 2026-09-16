import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { AuthUser, DeckDetail, DeckPreview } from './deck-types.ts';

export type DetailTab = 'preview' | 'overview' | 'visitors' | 'slides' | 'links' | 'access';

type PreviewInput = {
  readonly preview: DeckPreview | null;
  readonly detail: DeckDetail;
  readonly slideIndex: number;
  readonly canManage: boolean;
  readonly onMove: (delta: number) => void;
  readonly onRename: (event: Event) => void;
};

export function renderDeckPreview(input: PreviewInput): TemplateResult {
  const slide = input.preview?.slides[input.slideIndex];
  const slideCount = input.preview?.slides.length ?? 0;
  return html`<div class="detail-grid">
    <div class="stack">
      <div class="slide-stage">
        <div class="slide-canvas">${slide === undefined ? nothing : unsafeHTML(slide.html)}</div>
      </div>
      <div class="actions" aria-label="Preview navigation">
        <button
          class="button secondary"
          type="button"
          ?disabled=${input.slideIndex === 0}
          @click=${() => input.onMove(-1)}
        >
          Previous
        </button>
        <span class="caption"
          >Slide ${slideCount === 0 ? 0 : input.slideIndex + 1} of ${slideCount}</span
        >
        <button
          class="button secondary"
          type="button"
          ?disabled=${input.slideIndex >= slideCount - 1}
          @click=${() => input.onMove(1)}
        >
          Next
        </button>
      </div>
    </div>
    <aside class="stack">
      ${input.canManage
        ? html`<form class="surface stack" @submit=${input.onRename}>
            <h2>Deck identity</h2>
            <div class="field">
              <label for="deck-title">Title</label
              ><input id="deck-title" name="title" .value=${input.detail.title} />
            </div>
            <button class="button secondary" type="submit">Save title</button>
          </form>`
        : nothing}
      <section class="surface stack">
        <h2>Revision history</h2>
        ${input.detail.revisions.map(
          (revision) =>
            html`<div>
              <strong>Revision ${revision.revisionNumber}</strong><br /><span class="caption"
                >${revision.slideCount} slides · ${revision.createdByEmail} ·
                ${formatDate(revision.createdAt)}</span
              >
            </div>`,
        )}
      </section>
    </aside>
  </div>`;
}

type DeleteDialogInput = {
  readonly title: string;
  readonly onClose: () => void;
  readonly onDelete: () => void;
};

export function renderDeleteDialog(input: DeleteDialogInput): TemplateResult {
  return html`<dialog id="delete-dialog" aria-labelledby="delete-title">
    <div class="dialog-body">
      <p class="eyebrow">Permanent action</p>
      <h2 id="delete-title">Delete “${input.title}”?</h2>
      <p class="muted">
        Every share link and open viewer session is revoked immediately. Retained analytics then
        follow the workspace deletion and retention policy.
      </p>
      <div class="actions">
        <button class="button secondary" @click=${input.onClose}>Cancel</button
        ><button class="button destructive" @click=${input.onDelete}>Delete deck</button>
      </div>
    </div>
  </dialog>`;
}

type LoadedDetailInput = {
  readonly user: AuthUser | null;
  readonly detail: DeckDetail;
  readonly tabs: readonly DetailTab[];
  readonly activeTab: DetailTab;
  readonly analyticsDenied: boolean;
  readonly analyticsError: string | null;
  readonly canManage: boolean;
  readonly panel: (tab: DetailTab) => TemplateResult;
  readonly onTab: (tab: DetailTab) => void;
  readonly onTabKey: (event: KeyboardEvent) => void;
  readonly onArchive: () => void;
  readonly onOpenDelete: () => void;
  readonly onCloseDelete: () => void;
  readonly onDelete: () => void;
};

export function renderLoadedDeckPage(input: LoadedDetailInput): TemplateResult {
  return html`<a class="skip-link" href="#main">Skip to deck</a>
    <div class="shell product-shell">
      <header class="topbar">
        <a class="brand" href="/decks"><span class="brand-mark"></span>Pagent / Decks</a
        ><span class="caption">${input.user?.email ?? ''}</span>
      </header>
      <product-navigation current="decks"></product-navigation>
      <main class="page" id="main">
        <header class="page-head">
          <div>
            <p class="eyebrow">
              ${input.detail.clientLabel ?? 'Deck detail'} · revision
              ${input.detail.latestRevisionNumber}
            </p>
            <h1>${input.detail.title}</h1>
            <p class="lede">
              Owned by ${input.detail.ownerEmail} · last published
              ${formatDate(input.detail.lastPublishedAt)}
            </p>
          </div>
          ${input.canManage
            ? html`<div class="actions">
                <button class="button secondary" @click=${input.onArchive}>
                  ${input.detail.status === 'archived' ? 'Restore' : 'Archive'}</button
                ><button class="button destructive" @click=${input.onOpenDelete}>Delete</button>
              </div>`
            : nothing}
        </header>
        ${input.analyticsDenied
          ? html`<p class="notice">Analytics access is managed separately from deck content.</p>`
          : nothing}
        ${input.analyticsError
          ? html`<p class="notice error" role="alert">${input.analyticsError}</p>`
          : nothing}
        ${renderDeckTabs(input)}
      </main>
      ${input.canManage
        ? renderDeleteDialog({
            title: input.detail.title,
            onClose: input.onCloseDelete,
            onDelete: input.onDelete,
          })
        : nothing}
    </div>`;
}

type DeckTabsInput = Pick<LoadedDetailInput, 'tabs' | 'activeTab' | 'panel' | 'onTab' | 'onTabKey'>;

export function renderDeckTabs(input: DeckTabsInput): TemplateResult {
  return html`<div class="tabs" role="tablist" aria-label="Deck detail" @keydown=${input.onTabKey}>
      ${input.tabs.map(
        (tab) =>
          html`<button
            id=${`deck-tab-${tab}`}
            class="tab"
            role="tab"
            aria-selected=${String(input.activeTab === tab)}
            aria-controls=${`deck-panel-${tab}`}
            tabindex=${input.activeTab === tab ? '0' : '-1'}
            @click=${() => input.onTab(tab)}
          >
            ${tabLabel(tab)}
          </button>`,
      )}
    </div>
    ${input.tabs.map(
      (tab) =>
        html`<section
          id=${`deck-panel-${tab}`}
          class="tab-panel"
          role="tabpanel"
          aria-labelledby=${`deck-tab-${tab}`}
          ?hidden=${input.activeTab !== tab}
        >
          ${input.panel(tab)}
        </section>`,
    )}`;
}

function tabLabel(tab: DetailTab): string {
  if (tab === 'links') return 'Share links';
  if (tab === 'access') return 'Access & settings';
  return tab[0]?.toUpperCase() + tab.slice(1);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
