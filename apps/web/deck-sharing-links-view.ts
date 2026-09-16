import { html, nothing, type TemplateResult } from 'lit';
import type { ShareLink } from './deck-types.ts';

export type SharingLinksViewInput = {
  readonly links: readonly ShareLink[];
  readonly saving: boolean;
  readonly previewingLinkId: string | null;
  readonly requestsLoading: boolean;
  readonly decidingRequestId: string | null;
  readonly revokeCandidate: ShareLink | null;
  readonly onOpenEditor: (link: ShareLink) => void;
  readonly onOpenRevoke: (link: ShareLink) => void;
  readonly onPreview: (link: ShareLink) => void;
  readonly onShowRequests: (link: ShareLink) => void;
};

export function renderSharingLinks(input: SharingLinksViewInput): TemplateResult {
  if (input.links.length === 0)
    return html`<section class="surface empty">
      <h2>No share links</h2>
      <p class="muted">
        Create separate links for public, email-gated, or authenticated audiences.
      </p>
    </section>`;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Link</th>
          <th>Sender</th>
          <th>Access</th>
          <th>Expiry</th>
          <th>Status</th>
          <th>Visits</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${input.links.map((link) => renderSharingLinkRow(input, link))}
      </tbody>
    </table>
  </div>`;
}

function renderSharingLinkRow(input: SharingLinksViewInput, link: ShareLink): TemplateResult {
  const previewing = input.previewingLinkId === link.id;
  const requestBusy = input.requestsLoading || input.decidingRequestId !== null;
  const revoking = input.revokeCandidate?.id === link.id;
  return html`<tr>
    <td data-label="Link"><strong>${link.name}</strong></td>
    <td data-label="Sender">${link.creatorEmail}</td>
    <td data-label="Access">
      ${accessLabel(link.accessMode)}${link.accessMode === 'allowed_email'
        ? html`<br /><span class="badge unverified">Unverified</span>`
        : nothing}
    </td>
    <td data-label="Expiry">${link.expiresAt ? formatDate(link.expiresAt) : 'Never'}</td>
    <td data-label="Status">
      <span class=${`badge ${linkStatus(link)}`}>${linkStatus(link)}</span>
    </td>
    <td data-label="Visits" class="mono">${link.visitCount}</td>
    <td data-label="Actions">
      <div class="cluster">
        <button
          class="button quiet"
          ?disabled=${input.saving}
          @click=${() => input.onOpenEditor(link)}
        >
          Edit</button
        ><button
          class="button quiet"
          ?disabled=${requestBusy}
          @click=${() => input.onShowRequests(link)}
        >
          ${input.requestsLoading ? 'Loading requests…' : 'Requests'}</button
        ><button
          class="button quiet"
          ?disabled=${previewing}
          aria-busy=${String(previewing)}
          @click=${() => input.onPreview(link)}
        >
          ${previewing ? 'Opening…' : 'Preview'}</button
        >${link.revokedAt === null
          ? html`<button
              class="button quiet"
              ?disabled=${revoking}
              @click=${() => input.onOpenRevoke(link)}
            >
              Revoke
            </button>`
          : nothing}
      </div>
    </td>
  </tr>`;
}

function accessLabel(mode: ShareLink['accessMode']): string {
  return mode === 'allowed_email'
    ? 'Allowed email'
    : mode === 'authenticated'
      ? 'Authenticated viewer'
      : 'Anyone';
}

function linkStatus(link: ShareLink): 'active' | 'expired' | 'revoked' {
  if (link.revokedAt !== null) return 'revoked';
  return link.expiresAt !== null && new Date(link.expiresAt) <= new Date() ? 'expired' : 'active';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
