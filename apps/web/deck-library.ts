import { LitElement, html, nothing } from 'lit';
import { ApiError, apiEmpty, apiJson, loginUrl } from './deck-api.ts';
import { renderLibraryFilters } from './deck-library-filter-view.ts';
import { renderDeckTable } from './deck-library-table-view.ts';
import { authUserSchema, deckListSchema, type AuthUser, type DeckListItem } from './deck-types.ts';
import { buildDeckListQuery } from './deck-ui-state.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

class DeckLibrary extends LitElement {
  static properties = {
    user: { state: true },
    decks: { state: true },
    loading: { state: true },
    unauthorized: { state: true },
    error: { state: true },
    query: { state: true },
    scope: { state: true },
    statusFilter: { state: true },
    ownerFilter: { state: true },
    senderFilter: { state: true },
    filterOptions: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare user: AuthUser | null;
  declare decks: readonly DeckListItem[];
  declare loading: boolean;
  declare unauthorized: boolean;
  declare error: string | null;
  declare query: string;
  declare scope: 'mine' | 'shared' | 'team';
  declare statusFilter: '' | 'active' | 'archived' | 'expired' | 'revoked';
  declare ownerFilter: string;
  declare senderFilter: string;
  declare filterOptions: readonly DeckListItem[];

  constructor() {
    super();
    this.user = null;
    this.decks = [];
    this.loading = true;
    this.unauthorized = false;
    this.error = null;
    this.query = '';
    this.scope = 'mine';
    this.statusFilter = '';
    this.ownerFilter = '';
    this.senderFilter = '';
    this.filterOptions = [];
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadIdentityAndDecks();
  }

  private async loadIdentityAndDecks(): Promise<void> {
    try {
      this.user = await apiJson('/auth/me', authUserSchema);
      await this.loadDecks();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.unauthorized = true;
      else this.error = error instanceof Error ? error.message : 'Could not load pages';
    } finally {
      this.loading = false;
    }
  }

  private async loadDecks(): Promise<void> {
    const params = buildDeckListQuery({
      scope: this.scope,
      query: this.query,
      status: this.statusFilter,
      ownerId: this.ownerFilter,
      senderId: this.senderFilter,
    });
    const optionParams = new URLSearchParams({ scope: this.scope });
    const [result, options] = await Promise.all([
      apiJson(`/v1/decks?${params.toString()}`, deckListSchema),
      apiJson(`/v1/decks?${optionParams.toString()}`, deckListSchema),
    ]);
    this.decks = result.decks;
    this.filterOptions = options.decks;
  }

  private async applyFilters(event: Event): Promise<void> {
    event.preventDefault();
    this.loading = true;
    this.error = null;
    try {
      await this.loadDecks();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not filter pages';
    } finally {
      this.loading = false;
    }
  }

  private updateQuery(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) this.query = event.currentTarget.value;
  }

  private updateScope(event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    const parsed = event.currentTarget.value;
    if (parsed === 'mine' || parsed === 'shared' || parsed === 'team') {
      this.scope = parsed;
      this.ownerFilter = '';
      this.senderFilter = '';
    }
  }

  private updatePerson(event: Event, role: 'owner' | 'sender'): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    if (role === 'owner') this.ownerFilter = event.currentTarget.value;
    else this.senderFilter = event.currentTarget.value;
  }

  private updateStatus(event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    const parsed = event.currentTarget.value;
    if (
      parsed === '' ||
      parsed === 'active' ||
      parsed === 'archived' ||
      parsed === 'expired' ||
      parsed === 'revoked'
    ) {
      this.statusFilter = parsed;
    }
  }

  private async logout(): Promise<void> {
    await apiEmpty('/auth/logout', { method: 'POST' });
    location.assign('/');
  }

  render() {
    if (this.unauthorized) return this.renderSignedOut();
    return html`
      <a class="skip-link" href="#main">Skip to pages</a>
      <div class="shell product-shell">
        ${this.renderTopbar()}
        <product-navigation current="decks"></product-navigation>
        <main class="page" id="main">
          <header class="page-head">
            <div>
              <p class="eyebrow">Durable presentations</p>
              <h1>Pages</h1>
              <p class="lede">
                Publish from your agent, control every audience, and read engagement without
                guessing.
              </p>
            </div>
            <a class="button secondary" href="/">How to publish</a>
          </header>
          ${renderLibraryFilters({
            query: this.query,
            scope: this.scope,
            status: this.statusFilter,
            ownerId: this.ownerFilter,
            senderId: this.senderFilter,
            options: this.filterOptions,
            onSubmit: (event) => void this.applyFilters(event),
            onQuery: (event) => this.updateQuery(event),
            onScope: (event) => this.updateScope(event),
            onStatus: (event) => this.updateStatus(event),
            onOwner: (event) => this.updatePerson(event, 'owner'),
            onSender: (event) => this.updatePerson(event, 'sender'),
          })}
          ${this.error ? html`<p class="notice error" role="alert">${this.error}</p>` : nothing}
          ${this.loading ? this.renderLoading() : renderDeckTable(this.decks)}
        </main>
      </div>
    `;
  }

  private renderTopbar() {
    return html`<header class="topbar">
      <a class="brand" href="/"><span class="brand-mark"></span>Pagent</a>
      <div class="cluster">
        <span class="caption">${this.user?.email ?? ''}</span>
        <button class="button quiet" type="button" @click=${this.logout}>Sign out</button>
      </div>
    </header>`;
  }

  private renderSignedOut() {
    return html`<div class="shell">
      <main class="page">
        <section class="surface empty">
          <p class="eyebrow">Private workspace</p>
          <h1>Sign in to manage pages.</h1>
          <p class="lede">
            Your links, viewer identities, and analytics are only available to authorized workspace
            members.
          </p>
          <a class="button" href=${loginUrl('/pages')}>Continue securely</a>
        </section>
      </main>
    </div>`;
  }

  private renderLoading() {
    return html`<section class="surface stack" aria-busy="true" aria-label="Loading pages">
      ${[1, 2, 3, 4].map(() => html`<span class="loading-line"></span>`)}
    </section>`;
  }
}

customElements.define('deck-library', DeckLibrary);
