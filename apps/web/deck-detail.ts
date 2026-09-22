import { LitElement, type PropertyValues } from 'lit';
import { ApiError, apiEmpty, apiJson, loginUrl } from './deck-api.ts';
import './deck-analytics-panel.ts';
import './deck-access-panel.ts';
import './deck-sharing-panel.ts';
import {
  renderDeckDetailPanel,
  renderLoadingDeckDetailPage,
  renderUnauthorizedDeckDetailPage,
  renderUnavailableDeckDetailPage,
} from './deck-detail-page-view.ts';
import {
  availableDeckDetailTabs,
  canManageDeck,
  createDeckDetailPageState,
  deckDetailPageProperties,
  tabFromHash,
  type DeckMutation,
  type DetailTab,
} from './deck-detail-page-state.ts';
import { renderLoadedDeckPage } from './deck-detail-view.ts';
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

class DeckDetailPage extends LitElement {
  static properties = { ...deckDetailPageProperties, accessDenied: { state: true } };
  static styles = [productStyles, productLayoutStyles];

  declare deckId: string;
  declare user: AuthUser | null;
  declare detail: DeckDetail | null;
  declare preview: DeckPreview | null;
  declare analytics: DeckAnalytics | null;
  declare activeTab: DetailTab;
  declare loading: boolean;
  declare unauthorized: boolean;
  declare accessDenied: boolean;
  declare error: string | null;
  declare analyticsDenied: boolean;
  declare analyticsError: string | null;
  declare previewIndex: number;
  declare mutation: DeckMutation | null;
  declare mutationError: string | null;

  constructor() {
    super();
    this.deckId = '';
    Object.assign(this, createDeckDetailPageState(location.hash));
    this.accessDenied = false;
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
    this.activeTab = tabFromHash(location.hash);
  };

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.accessDenied = false;
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
      else {
        this.accessDenied = error instanceof ApiError && error.status === 403;
        this.error = 'Page unavailable';
      }
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
    return availableDeckDetailTabs(
      this.analytics !== null,
      this.canManage(),
      this.analytics?.contentFormat !== 'html',
    );
  }

  private canManage(): boolean {
    return canManageDeck(this.user, this.detail);
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
    if (this.mutation !== null) return;
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const title = new FormData(event.currentTarget).get('title');
    if (typeof title !== 'string' || title.trim().length === 0) {
      this.mutationError = 'Enter a title before saving.';
      return;
    }
    this.mutation = 'rename';
    this.mutationError = null;
    try {
      await apiEmpty(`/v1/decks/${this.deckId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: title.trim() }),
      });
      if (this.detail !== null) this.detail = { ...this.detail, title: title.trim() };
    } catch (error) {
      this.mutationError = error instanceof Error ? error.message : 'Could not save title.';
    } finally {
      this.mutation = null;
    }
  }

  private async toggleArchive(): Promise<void> {
    if (this.mutation !== null || this.detail === null) return;
    const action = this.detail?.status === 'archived' ? 'restore' : 'archive';
    this.mutation = 'archive';
    this.mutationError = null;
    try {
      await apiEmpty(`/v1/decks/${this.deckId}/${action}`, { method: 'POST' });
      this.detail = {
        ...this.detail,
        status: action === 'archive' ? 'archived' : 'active',
      };
    } catch (error) {
      this.mutationError =
        error instanceof Error
          ? error.message
          : action === 'archive'
            ? 'Could not archive page.'
            : 'Could not restore page.';
    } finally {
      this.mutation = null;
    }
  }

  private openDelete(): void {
    this.mutationError = null;
    const dialog = this.renderRoot.querySelector('#delete-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  private closeDelete(): void {
    if (this.mutation === 'delete') return;
    const dialog = this.renderRoot.querySelector('#delete-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.close();
  }

  private async deleteDeck(): Promise<void> {
    if (this.mutation !== null) return;
    this.mutation = 'delete';
    this.mutationError = null;
    try {
      await apiEmpty(`/v1/decks/${this.deckId}`, { method: 'DELETE' });
      location.assign('/pages');
    } catch (error) {
      this.mutationError = error instanceof Error ? error.message : 'Could not delete page.';
    } finally {
      this.mutation = null;
    }
  }

  render() {
    if (this.unauthorized) return renderUnauthorizedDeckDetailPage(loginUrl(location.pathname));
    if (this.loading) return renderLoadingDeckDetailPage();
    if (this.error || this.detail === null)
      return renderUnavailableDeckDetailPage(this.accessDenied);
    const detail = this.detail;
    return renderLoadedDeckPage({
      user: this.user,
      detail,
      tabs: this.availableTabs(),
      activeTab: this.activeTab,
      analyticsDenied: this.analyticsDenied,
      analyticsError: this.analyticsError,
      canManage: this.canManage(),
      mutation: this.mutation,
      mutationError: this.mutationError,
      panel: (tab) => this.renderPanel(tab, detail),
      onTab: (tab) => this.chooseTab(tab),
      onTabKey: (event) => this.onTabKey(event),
      onArchive: () => void this.toggleArchive(),
      onOpenDelete: () => this.openDelete(),
      onCloseDelete: () => this.closeDelete(),
      onDelete: () => void this.deleteDeck(),
    });
  }

  private renderPanel(tab: DetailTab, detail: DeckDetail) {
    return renderDeckDetailPanel(tab, {
      deckId: this.deckId,
      detail,
      preview: this.preview,
      analytics: this.analytics,
      previewIndex: this.previewIndex,
      canManage: this.canManage(),
      renaming: this.mutation === 'rename',
      mutationError: this.mutationError,
      onMove: (delta) => this.movePreview(delta),
      onRename: (event) => void this.rename(event),
    });
  }
}

customElements.define('deck-detail-page', DeckDetailPage);
