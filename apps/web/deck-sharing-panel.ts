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
import { parseShareLinkFormData } from './deck-sharing-form-data.ts';
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
    saveError: { state: true },
    error: { state: true },
    createdUrl: { state: true },
    revokeCandidate: { state: true },
    revoking: { state: true },
    previewingLinkId: { state: true },
    requestsLoading: { state: true },
    decidingRequestId: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare deckId: string;
  declare links: readonly ShareLink[];
  declare requests: readonly AccessRequest[];
  declare requestLinkId: string | null;
  declare editing: ShareLink | null;
  declare loading: boolean;
  declare saving: boolean;
  declare saveError: string | null;
  declare error: string | null;
  declare createdUrl: string | null;
  declare revokeCandidate: ShareLink | null;
  declare revoking: boolean;
  declare previewingLinkId: string | null;
  declare requestsLoading: boolean;
  declare decidingRequestId: string | null;

  constructor() {
    super();
    this.deckId = '';
    this.links = [];
    this.requests = [];
    this.requestLinkId = null;
    this.editing = null;
    this.loading = true;
    this.saving = false;
    this.saveError = null;
    this.error = null;
    this.createdUrl = null;
    this.revokeCandidate = null;
    this.revoking = false;
    this.previewingLinkId = null;
    this.requestsLoading = false;
    this.decidingRequestId = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadLinks();
  }

  private async loadLinks(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.links = (await apiJson(`/v1/decks/${this.deckId}/share-links`, shareLinksSchema)).links;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not load links';
    } finally {
      this.loading = false;
    }
  }

  private async openEditor(link: ShareLink | null): Promise<void> {
    if (this.saving) return;
    this.editing = link;
    this.createdUrl = null;
    this.saveError = null;
    await this.updateComplete;
    const dialog = this.renderRoot.querySelector('#link-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  private closeEditor(force = false): void {
    if (this.saving && !force) return;
    const dialog = this.renderRoot.querySelector('#link-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.close();
  }

  private async saveLink(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving) return;
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const body = parseShareLinkFormData(new FormData(event.currentTarget));
    this.saving = true;
    this.saveError = null;
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
        this.closeEditor(true);
      }
      await this.loadLinks();
    } catch (error) {
      this.saveError = error instanceof Error ? error.message : 'Could not save link';
    } finally {
      this.saving = false;
    }
  }

  private async openRevoke(link: ShareLink): Promise<void> {
    if (this.revoking) return;
    this.revokeCandidate = link;
    this.error = null;
    await this.updateComplete;
    const dialog = this.renderRoot.querySelector('#revoke-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  private closeRevoke(): void {
    if (this.revoking) return;
    this.revokeCandidate = null;
    const dialog = this.renderRoot.querySelector('#revoke-dialog');
    if (dialog instanceof HTMLDialogElement) dialog.close();
  }

  private async confirmRevoke(): Promise<void> {
    const link = this.revokeCandidate;
    if (link === null || this.revoking) return;
    this.revoking = true;
    this.error = null;
    try {
      await apiEmpty(`/v1/decks/${this.deckId}/share-links/${link.id}/revoke`, { method: 'POST' });
      this.revokeCandidate = null;
      const dialog = this.renderRoot.querySelector('#revoke-dialog');
      if (dialog instanceof HTMLDialogElement) dialog.close();
      await this.loadLinks();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not revoke link.';
    } finally {
      this.revoking = false;
    }
  }

  private async preview(link: ShareLink): Promise<void> {
    if (this.previewingLinkId !== null) return;
    this.previewingLinkId = link.id;
    this.error = null;
    try {
      const access = await apiJson(
        `/v1/decks/${this.deckId}/share-links/${link.id}/preview`,
        viewerAccessSchema,
        { method: 'POST' },
      );
      if (access.kind !== 'granted') {
        this.error = 'Could not open the owner preview. Try again.';
        return;
      }
      sessionStorage.setItem('pagent-owner-preview', access.sessionToken);
      location.assign('/view');
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not open the owner preview.';
    } finally {
      this.previewingLinkId = null;
    }
  }

  private async showRequests(link: ShareLink): Promise<void> {
    if (this.requestsLoading) return;
    this.requestLinkId = link.id;
    this.requests = [];
    this.requestsLoading = true;
    this.error = null;
    try {
      this.requests = (
        await apiJson(
          `/v1/decks/${this.deckId}/share-links/${link.id}/requests`,
          accessRequestsSchema,
        )
      ).requests;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not load access requests.';
    } finally {
      this.requestsLoading = false;
    }
  }

  private async decide(request: AccessRequest, decision: 'approved' | 'denied'): Promise<void> {
    if (this.requestLinkId === null || this.decidingRequestId !== null) return;
    this.decidingRequestId = request.id;
    this.error = null;
    const link = this.links.find((candidate) => candidate.id === this.requestLinkId);
    try {
      await apiEmpty(
        `/v1/decks/${this.deckId}/share-links/${this.requestLinkId}/requests/${request.id}`,
        { method: 'POST', body: JSON.stringify({ decision }) },
      );
      if (link !== undefined) await this.showRequests(link);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not update access request.';
    } finally {
      this.decidingRequestId = null;
    }
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
      saveError: this.saveError,
      createdUrl: this.createdUrl,
      revokeCandidate: this.revokeCandidate,
      revoking: this.revoking,
      previewingLinkId: this.previewingLinkId,
      requestsLoading: this.requestsLoading,
      decidingRequestId: this.decidingRequestId,
      onOpenEditor: (link) => void this.openEditor(link),
      onCloseEditor: () => this.closeEditor(),
      onSaveLink: (event) => void this.saveLink(event),
      onOpenRevoke: (link) => void this.openRevoke(link),
      onCloseRevoke: () => this.closeRevoke(),
      onConfirmRevoke: () => void this.confirmRevoke(),
      onPreview: (link) => void this.preview(link),
      onShowRequests: (link) => void this.showRequests(link),
      onDecide: (request, decision) => void this.decide(request, decision),
      onCopyCreated: () => void this.copyCreated(),
    });
  }
}
customElements.define('deck-sharing-panel', DeckSharingPanel);
