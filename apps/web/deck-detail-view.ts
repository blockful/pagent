import { html, nothing, type TemplateResult } from 'lit';
import { formatDate } from './deck-detail-preview-view.ts';
import type { DeckMutation, DetailTab } from './deck-detail-page-state.ts';
import type { AuthUser, DeckDetail } from './deck-types.ts';

export { formatDate, renderDeckPreview } from './deck-detail-preview-view.ts';
export type { DeckPreviewInput } from './deck-detail-preview-view.ts';
export type { DetailTab } from './deck-detail-page-state.ts';

type DeleteDialogInput = {
  readonly title: string;
  readonly deleting: boolean;
  readonly mutationError: string | null;
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
      ${input.mutationError
        ? html`<p class="notice error" role="alert">${input.mutationError}</p>`
        : nothing}
      <div class="actions">
        <button class="button secondary" ?disabled=${input.deleting} @click=${input.onClose}>
          Cancel</button
        ><button
          class="button destructive"
          ?disabled=${input.deleting}
          aria-busy=${String(input.deleting)}
          @click=${input.onDelete}
        >
          ${input.deleting ? 'Deleting…' : 'Delete page'}
        </button>
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
  readonly mutation: DeckMutation | null;
  readonly mutationError: string | null;
  readonly panel: (tab: DetailTab) => TemplateResult;
  readonly onTab: (tab: DetailTab) => void;
  readonly onTabKey: (event: KeyboardEvent) => void;
  readonly onArchive: () => void;
  readonly onOpenDelete: () => void;
  readonly onCloseDelete: () => void;
  readonly onDelete: () => void;
};

export function renderLoadedDeckPage(input: LoadedDetailInput): TemplateResult {
  const mutationBusy = input.mutation !== null;
  const archiving = input.mutation === 'archive';
  return html`<a class="skip-link" href="#main">Skip to page</a>
    <div class="shell product-shell">
      <header class="topbar">
        <a class="brand" href="/pages"><span class="brand-mark"></span>Pagent / Pages</a
        ><span class="caption">${input.user?.email ?? ''}</span>
      </header>
      <product-navigation current="decks"></product-navigation>
      <main class="page" id="main">
        <header class="page-head">
          <div>
            <p class="eyebrow">
              ${input.detail.clientLabel ?? 'Presentation page'} · revision
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
                <button
                  class="button secondary"
                  ?disabled=${mutationBusy}
                  aria-busy=${String(archiving)}
                  @click=${input.onArchive}
                >
                  ${archiving
                    ? input.detail.status === 'archived'
                      ? 'Restoring…'
                      : 'Archiving…'
                    : input.detail.status === 'archived'
                      ? 'Restore'
                      : 'Archive'}</button
                ><button
                  class="button destructive"
                  ?disabled=${mutationBusy}
                  @click=${input.onOpenDelete}
                >
                  Delete
                </button>
              </div>`
            : nothing}
        </header>
        ${input.mutationError
          ? html`<p class="notice error" role="alert">${input.mutationError}</p>`
          : nothing}
        ${input.analyticsDenied
          ? html`<p class="notice">Analytics access is managed separately from page content.</p>`
          : nothing}
        ${input.analyticsError
          ? html`<p class="notice error" role="alert">${input.analyticsError}</p>`
          : nothing}
        ${renderDeckTabs(input)}
      </main>
      ${input.canManage
        ? renderDeleteDialog({
            title: input.detail.title,
            deleting: input.mutation === 'delete',
            mutationError: input.mutationError,
            onClose: input.onCloseDelete,
            onDelete: input.onDelete,
          })
        : nothing}
    </div>`;
}

type DeckTabsInput = Pick<LoadedDetailInput, 'tabs' | 'activeTab' | 'panel' | 'onTab' | 'onTabKey'>;

export function renderDeckTabs(input: DeckTabsInput): TemplateResult {
  return html`<div class="tabs" role="tablist" aria-label="Page detail" @keydown=${input.onTabKey}>
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
  if (tab === 'access') return 'Permissions';
  return tab[0]?.toUpperCase() + tab.slice(1);
}
