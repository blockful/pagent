import { LitElement, html, type PropertyValues } from 'lit';
import { ApiError, apiEmpty, apiJson, loginUrl } from './deck-api.ts';
import './deck-analytics-panel.ts';
import './deck-access-panel.ts';
import './deck-sharing-panel.ts';
import { renderDeckPreview, renderLoadedDeckPage, type DetailTab } from './deck-detail-view.ts';
import {
  analyticsSchema,
  authUserSchema,
  deckDetailSchema,
  deckPreviewSchema,
  type AuthUser,
  type DeckAnalytics,
  type DeckDetail,
  type DeckPreview,
} from './deck-types.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';
import { nextPreviewIndex, nextRovingTab } from './deck-ui-state.ts';

const tabs: readonly DetailTab[] = ['preview', 'overview', 'visitors', 'slides', 'links', 'access'];

class DeckDetailPage extends LitElement {
  static properties = {
    deckId: { type: String },
    user: { state: true },
    detail: { state: true },
    preview: { state: true },
    analytics: { state: true },
    activeTab: { state: true },
    loading: { state: true },
    unauthorized: { state: true },
    error: { state: true },
    analyticsDenied: { state: true },
    analyticsError: { state: true },
    previewIndex: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare deckId: string;
  declare user: AuthUser | null;
  declare detail: DeckDetail | null;
  declare preview: DeckPreview | null;
  declare analytics: DeckAnalytics | null;
  declare activeTab: DetailTab;
  declare loading: boolean;
  declare unauthorized: boolean;
  declare error: string | null;
  declare analyticsDenied: boolean;
  declare analyticsError: string | null;
  declare previewIndex: number;

  constructor() {
    super();
    this.deckId = '';
    this.user = null;
    this.detail = null;
    this.preview = null;
    this.analytics = null;
    this.activeTab = tabFromHash();
    this.loading = true;
    this.unauthorized = false;
    this.error = null;
    this.analyticsDenied = false;
    this.analyticsError = null;
    this.previewIndex = 0;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
    void this.load();
  }

  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues<this>): void {
    if (!changed.has('activeTab') && !changed.has('loading')) return;
    const selected = this.renderRoot.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    if (selected === null) return;
    selected.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }

  private onHashChange = (): void => {
    this.activeTab = tabFromHash();
  };

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.analyticsDenied = false;
    this.analyticsError = null;
    try {
      const [user, detail, preview] = await Promise.all([
        apiJson('/auth/me', authUserSchema),
        apiJson(`/v1/decks/${this.deckId}`, deckDetailSchema),
        apiJson(`/v1/decks/${this.deckId}/preview`, deckPreviewSchema),
      ]);
      this.user = user;
      this.detail = detail;
      this.preview = preview;
      this.previewIndex = nextPreviewIndex({
        current: this.previewIndex,
        delta: 0,
        slideCount: preview.slides.length,
      });
      try {
        this.analytics = await apiJson(`/v1/decks/${this.deckId}/analytics`, analyticsSchema);
      } catch (error) {
        this.analytics = null;
        if (error instanceof ApiError && error.status === 403) this.analyticsDenied = true;
        else this.analyticsError = error instanceof Error ? error.message : 'Analytics unavailable';
      }
      if (!this.availableTabs().includes(this.activeTab)) this.chooseTab('preview');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.unauthorized = true;
      else this.error = error instanceof Error ? error.message : 'Could not load deck';
    } finally {
      this.loading = false;
    }
  }

  private chooseTab(tab: DetailTab): void {
    this.activeTab = tab;
    history.replaceState(null, '', `#${tab}`);
  }

  private onTabKey(event: KeyboardEvent): void {
    const availableTabs = this.availableTabs();
    const tab = nextRovingTab(availableTabs, this.activeTab, event.key);
    if (tab === null) return;
    event.preventDefault();
    this.chooseTab(tab);
    this.renderRoot.querySelector<HTMLElement>(`#deck-tab-${tab}`)?.focus();
  }

  private availableTabs(): readonly DetailTab[] {
    const analyticsTabs: readonly DetailTab[] =
      this.analytics === null ? [] : ['overview', 'visitors', 'slides'];
    const managementTabs: readonly DetailTab[] = this.canManage() ? ['links', 'access'] : [];
    return ['preview', ...analyticsTabs, ...managementTabs];
  }

  private canManage(): boolean {
    return this.user !== null && this.detail !== null && this.user.id === this.detail.ownerId;
  }

  private movePreview(delta: number): void {
    this.previewIndex = nextPreviewIndex({
      current: this.previewIndex,
      delta,
      slideCount: this.preview?.slides.length ?? 0,
    });
  }

  private async rename(event: Event): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const title = new FormData(event.currentTarget).get('title');
    if (typeof title !== 'string' || title.trim().length === 0) return;
    await apiEmpty(`/v1/decks/${this.deckId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    await this.load();
  }

  private async toggleArchive(): Promise<void> {
    const action = this.detail?.status === 'archived' ? 'restore' : 'archive';
    await apiEmpty(`/v1/decks/${this.deckId}/${action}`, { method: 'POST' });
    await this.load();
  }

  private openDelete(): void {
    const dialog = this.renderRoot.querySelector('#delete-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  private closeDelete(): void {
    const dialog = this.renderRoot.querySelector('#delete-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.close();
  }

  private async deleteDeck(): Promise<void> {
    await apiEmpty(`/v1/decks/${this.deckId}`, { method: 'DELETE' });
    location.assign('/decks');
  }

  render() {
    if (this.unauthorized)
      return html`<section class="shell">
        <main class="page">
          <div class="surface empty">
            <h1>Sign in to view this deck.</h1>
            <a class="button" href=${loginUrl(location.pathname)}>Continue securely</a>
          </div>
        </main>
      </section>`;
    if (this.loading)
      return html`<section class="shell">
        <main class="page">
          <div class="surface stack" aria-busy="true">
            ${[1, 2, 3, 4].map(() => html`<span class="loading-line"></span>`)}
          </div>
        </main>
      </section>`;
    if (this.error || this.detail === null)
      return html`<section class="shell">
        <main class="page">
          <p class="notice error" role="alert">${this.error ?? 'Deck unavailable'}</p>
        </main>
      </section>`;
    return renderLoadedDeckPage({
      user: this.user,
      detail: this.detail,
      tabs: this.availableTabs(),
      activeTab: this.activeTab,
      analyticsDenied: this.analyticsDenied,
      analyticsError: this.analyticsError,
      canManage: this.canManage(),
      panel: (tab) => this.renderPanel(tab),
      onTab: (tab) => this.chooseTab(tab),
      onTabKey: (event) => this.onTabKey(event),
      onArchive: () => void this.toggleArchive(),
      onOpenDelete: () => this.openDelete(),
      onCloseDelete: () => this.closeDelete(),
      onDelete: () => void this.deleteDeck(),
    });
  }

  private renderPanel(tab: DetailTab) {
    if (this.detail === null) return html``;
    if (tab === 'preview')
      return renderDeckPreview({
        preview: this.preview,
        detail: this.detail,
        slideIndex: this.previewIndex,
        canManage: this.canManage(),
        onMove: (delta) => this.movePreview(delta),
        onRename: (event) => void this.rename(event),
      });
    if (tab === 'links')
      return html`<deck-sharing-panel .deckId=${this.deckId}></deck-sharing-panel>`;
    if (tab === 'access')
      return html`<deck-access-panel .deckId=${this.deckId}></deck-access-panel>`;
    return html`<deck-analytics-panel
      .analytics=${this.analytics}
      .deckId=${this.deckId}
      .view=${tab}
    ></deck-analytics-panel>`;
  }
}

function tabFromHash(): DetailTab {
  const value = location.hash.replace('#', '');
  return tabs.find((tab) => tab === value) ?? 'preview';
}

customElements.define('deck-detail-page', DeckDetailPage);
