import { html, nothing, type TemplateResult } from 'lit';
import type { AccessRequest, ShareLink } from './deck-types.ts';

export type SharingRequestsViewInput = {
  readonly requests: readonly AccessRequest[];
  readonly requestLinkId: string | null;
  readonly requestsLoading: boolean;
  readonly decidingRequestId: string | null;
  readonly onDecide: (request: AccessRequest, decision: 'approved' | 'denied') => void;
};

export type SharingRevokeViewInput = {
  readonly error: string | null;
  readonly revokeCandidate: ShareLink | null;
  readonly revoking: boolean;
  readonly onCloseRevoke: () => void;
  readonly onConfirmRevoke: () => void;
};

export function renderSharingRequests(
  input: SharingRequestsViewInput,
): TemplateResult | typeof nothing {
  if (input.requestLinkId === null) return nothing;
  return html`<section class="surface stack" aria-busy=${String(input.requestsLoading)}>
    <h2>Access requests</h2>
    ${input.requestsLoading
      ? html`<p class="muted" aria-busy="true">Loading access requests…</p>`
      : input.requests.length === 0
        ? html`<p class="muted">No requests for this link.</p>`
        : input.requests.map((request) => renderSharingRequest(input, request))}
  </section>`;
}

export function renderSharingRevokeDialog(
  input: SharingRevokeViewInput,
): TemplateResult | typeof nothing {
  const link = input.revokeCandidate;
  if (link === null) return nothing;
  return html`<dialog
    id="revoke-dialog"
    aria-labelledby="revoke-title"
    @close=${input.onCloseRevoke}
  >
    <div class="dialog-body" aria-busy=${String(input.revoking)}>
      <p class="eyebrow">Permanent link action</p>
      <h2 id="revoke-title">Revoke “${link.name}”?</h2>
      <p class="muted">Open viewer sessions using this link will stop immediately.</p>
      ${input.error ? html`<p class="notice error" role="alert">${input.error}</p>` : nothing}
      <div class="actions">
        <button class="button secondary" ?disabled=${input.revoking} @click=${input.onCloseRevoke}>
          Cancel
        </button>
        <button
          class="button destructive"
          ?disabled=${input.revoking}
          aria-busy=${String(input.revoking)}
          @click=${input.onConfirmRevoke}
        >
          ${input.revoking ? 'Revoking…' : 'Revoke link'}
        </button>
      </div>
    </div>
  </dialog>`;
}

function renderSharingRequest(
  input: SharingRequestsViewInput,
  request: AccessRequest,
): TemplateResult {
  const deciding = input.decidingRequestId === request.id;
  return html`<div class="page-head">
    <div>
      <strong>${request.requestedEmail}</strong><br /><span class="badge ${request.status}"
        >${request.status}</span
      >
    </div>
    ${request.status === 'pending'
      ? html`<div class="actions">
          <button
            class="button secondary"
            ?disabled=${deciding}
            aria-busy=${String(deciding)}
            @click=${() => input.onDecide(request, 'denied')}
          >
            ${deciding ? 'Denying…' : 'Deny'}</button
          ><button
            class="button"
            ?disabled=${deciding}
            aria-busy=${String(deciding)}
            @click=${() => input.onDecide(request, 'approved')}
          >
            ${deciding ? 'Approving…' : 'Approve'}
          </button>
        </div>`
      : nothing}
  </div>`;
}
