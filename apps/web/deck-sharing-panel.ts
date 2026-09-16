import { LitElement } from 'lit';
import { apiEmpty, apiJson } from './deck-api.ts';
import {
  accessRequestsSchema,
  createdShareLinkSchema,
  shareLinksSchema,
  type AccessRequest,
  type ShareLink,
} from './deck-types.ts';
import { viewerAccessSchema } from './viewer-types.ts';
import { renderSharingPanel } from './deck-sharing-view.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

class DeckSharingPanel extends LitElement {
  static properties = {
    deckId: { type: String },
    links: { state: true },
    requests: { state: true },
    requestLinkId: { state: true },
    editing: { state: true },
    loading: { state: true },
    saving: { state: true },
    error: { state: true },
    createdUrl: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare deckId: string;
  declare links: readonly ShareLink[];
  declare requests: readonly AccessRequest[];
  declare requestLinkId: string | null;
  declare editing: ShareLink | null;
  declare loading: boolean;
  declare saving: boolean;
  declare error: string | null;
  declare createdUrl: string | null;

  constructor() {
    super();
    this.deckId = '';
    this.links = [];
    this.requests = [];
    this.requestLinkId = null;
    this.editing = null;
    this.loading = true;
    this.saving = false;
    this.error = null;
    this.createdUrl = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadLinks();
  }

  private async loadLinks(): Promise<void> {
    this.loading = true;
    try {
      this.links = (await apiJson(`/v1/decks/${this.deckId}/share-links`, shareLinksSchema)).links;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not load links';
    } finally {
      this.loading = false;
    }
  }

  private async openEditor(link: ShareLink | null): Promise<void> {
    this.editing = link;
    this.createdUrl = null;
    await this.updateComplete;
    const dialog = this.renderRoot.querySelector('#link-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  private closeEditor(): void {
    const dialog = this.renderRoot.querySelector('#link-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.close();
  }

  private async saveLink(event: Event): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const data = new FormData(event.currentTarget);
    const name = value(data, 'name');
    const audience = value(data, 'audience');
    const requireAuth = data.get('require_auth') === 'on';
    const values = value(data, 'allowed')
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const allowedEmails = values.filter((entry) => entry.includes('@') && !entry.startsWith('@'));
    const allowedDomains = values.filter((entry) => !entry.includes('@') || entry.startsWith('@'));
    const expiry = value(data, 'expires_at');
    const accessMode =
      audience === 'anyone' ? 'anyone' : requireAuth ? 'authenticated' : 'allowed_email';
    const body = {
      name,
      access_mode: accessMode,
      allowed_emails: audience === 'anyone' ? [] : allowedEmails,
      allowed_domains: audience === 'anyone' ? [] : allowedDomains,
      ...(expiry ? { expires_at: new Date(expiry).toISOString() } : {}),
    };
    this.saving = true;
    this.error = null;
    try {
      if (this.editing === null) {
        const created = await apiJson(
          `/v1/decks/${this.deckId}/share-links`,
          createdShareLinkSchema,
          { method: 'POST', body: JSON.stringify(body) },
        );
        this.createdUrl = `${location.origin}/share/${created.token}`;
      } else {
        await apiEmpty(`/v1/decks/${this.deckId}/share-links/${this.editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        this.closeEditor();
      }
      await this.loadLinks();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not save link';
    } finally {
      this.saving = false;
    }
  }

  private async revoke(link: ShareLink): Promise<void> {
    if (!window.confirm(`Revoke “${link.name}” now? Open viewer sessions will stop immediately.`))
      return;
    await apiEmpty(`/v1/decks/${this.deckId}/share-links/${link.id}/revoke`, { method: 'POST' });
    await this.loadLinks();
  }

  private async preview(link: ShareLink): Promise<void> {
    const access = await apiJson(
      `/v1/decks/${this.deckId}/share-links/${link.id}/preview`,
      viewerAccessSchema,
      { method: 'POST' },
    );
    if (access.kind !== 'granted') return;
    sessionStorage.setItem('pagent-owner-preview', access.sessionToken);
    location.assign('/view');
  }

  private async showRequests(link: ShareLink): Promise<void> {
    this.requestLinkId = link.id;
    this.requests = (
      await apiJson(
        `/v1/decks/${this.deckId}/share-links/${link.id}/requests`,
        accessRequestsSchema,
      )
    ).requests;
  }

  private async decide(request: AccessRequest, decision: 'approved' | 'denied'): Promise<void> {
    if (this.requestLinkId === null) return;
    await apiEmpty(
      `/v1/decks/${this.deckId}/share-links/${this.requestLinkId}/requests/${request.id}`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    );
    const link = this.links.find((candidate) => candidate.id === this.requestLinkId);
    if (link !== undefined) await this.showRequests(link);
  }

  private async copyCreated(): Promise<void> {
    if (this.createdUrl !== null) await navigator.clipboard.writeText(this.createdUrl);
  }

  render() {
    return renderSharingPanel({
      links: this.links,
      requests: this.requests,
      requestLinkId: this.requestLinkId,
      editing: this.editing,
      loading: this.loading,
      saving: this.saving,
      error: this.error,
      createdUrl: this.createdUrl,
      onOpenEditor: (link) => void this.openEditor(link),
      onCloseEditor: () => this.closeEditor(),
      onSaveLink: (event) => void this.saveLink(event),
      onRevoke: (link) => void this.revoke(link),
      onPreview: (link) => void this.preview(link),
      onShowRequests: (link) => void this.showRequests(link),
      onDecide: (request, decision) => void this.decide(request, decision),
      onCopyCreated: () => void this.copyCreated(),
    });
  }
}

function value(data: FormData, key: string): string {
  const result = data.get(key);
  return typeof result === 'string' ? result.trim() : '';
}
customElements.define('deck-sharing-panel', DeckSharingPanel);
