import { html, nothing, type TemplateResult } from 'lit';
import type { AccessRequest, ShareLink } from './deck-types.ts';
import { isSpecificAudience, renderSharingEditor } from './deck-sharing-editor-view.ts';
import { renderSharingLinks } from './deck-sharing-links-view.ts';
import { renderSharingRequests, renderSharingRevokeDialog } from './deck-sharing-access-view.ts';

type SharingPanelViewInput = {
  readonly links: readonly ShareLink[];
  readonly requests: readonly AccessRequest[];
  readonly requestLinkId: string | null;
  readonly editing: ShareLink | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly saveError: string | null;
  readonly createdUrl: string | null;
  readonly revokeCandidate: ShareLink | null;
  readonly revoking: boolean;
  readonly previewingLinkId: string | null;
  readonly requestsLoading: boolean;
  readonly decidingRequestId: string | null;
  readonly onOpenEditor: (link: ShareLink | null) => void;
  readonly onCloseEditor: () => void;
  readonly onSaveLink: (event: Event) => void;
  readonly onOpenRevoke: (link: ShareLink) => void;
  readonly onCloseRevoke: () => void;
  readonly onConfirmRevoke: () => void;
  readonly onPreview: (link: ShareLink) => void;
  readonly onShowRequests: (link: ShareLink) => void;
  readonly onDecide: (request: AccessRequest, decision: 'approved' | 'denied') => void;
  readonly onCopyCreated: () => void;
};

export { isSpecificAudience };

export function renderSharingPanel(input: SharingPanelViewInput): TemplateResult {
  return html`<div class="stack">
    <section class="page-head">
      <div>
        <p class="eyebrow">Named audiences</p>
        <h2>Share links</h2>
        <p class="muted">
          Each link owns its access rule, sender attribution, expiry, and analytics.
        </p>
      </div>
      <button class="button" ?disabled=${input.saving} @click=${() => input.onOpenEditor(null)}>
        Create share link
      </button>
    </section>
    ${input.error ? html`<p class="notice error" role="alert">${input.error}</p>` : nothing}
    ${input.loading
      ? html`<div class="surface stack" aria-busy="true">
          <span class="loading-line"></span><span class="loading-line"></span>
        </div>`
      : renderSharingLinks({
          links: input.links,
          saving: input.saving,
          previewingLinkId: input.previewingLinkId,
          requestsLoading: input.requestsLoading,
          decidingRequestId: input.decidingRequestId,
          revokeCandidate: input.revokeCandidate,
          onOpenEditor: input.onOpenEditor,
          onOpenRevoke: input.onOpenRevoke,
          onPreview: input.onPreview,
          onShowRequests: input.onShowRequests,
        })}
    ${renderSharingRequests({
      requests: input.requests,
      requestLinkId: input.requestLinkId,
      requestsLoading: input.requestsLoading,
      decidingRequestId: input.decidingRequestId,
      onDecide: input.onDecide,
    })}
    ${renderSharingEditor({
      editing: input.editing,
      saving: input.saving,
      saveError: input.saveError,
      createdUrl: input.createdUrl,
      onCloseEditor: input.onCloseEditor,
      onSaveLink: input.onSaveLink,
      onCopyCreated: input.onCopyCreated,
    })}
    ${renderSharingRevokeDialog({
      error: input.error,
      revokeCandidate: input.revokeCandidate,
      revoking: input.revoking,
      onCloseRevoke: input.onCloseRevoke,
      onConfirmRevoke: input.onConfirmRevoke,
    })}
  </div>`;
}
