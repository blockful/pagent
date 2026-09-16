import { html, nothing, type TemplateResult } from 'lit';
import type { AccessRequest, ShareLink } from './deck-types.ts';

type SharingPanelViewInput = {
  readonly links: readonly ShareLink[];
  readonly requests: readonly AccessRequest[];
  readonly requestLinkId: string | null;
  readonly editing: ShareLink | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly createdUrl: string | null;
  readonly onOpenEditor: (link: ShareLink | null) => void;
  readonly onCloseEditor: () => void;
  readonly onSaveLink: (event: Event) => void;
  readonly onRevoke: (link: ShareLink) => void;
  readonly onPreview: (link: ShareLink) => void;
  readonly onShowRequests: (link: ShareLink) => void;
  readonly onDecide: (request: AccessRequest, decision: 'approved' | 'denied') => void;
  readonly onCopyCreated: () => void;
};

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
      <button class="button" @click=${() => input.onOpenEditor(null)}>Create share link</button>
    </section>
    ${input.error ? html`<p class="notice error" role="alert">${input.error}</p>` : nothing}
    ${input.loading
      ? html`<div class="surface stack" aria-busy="true">
          <span class="loading-line"></span><span class="loading-line"></span>
        </div>`
      : renderLinks(input)}
    ${renderRequests(input)} ${renderEditor(input)}
  </div>`;
}

function renderLinks(input: SharingPanelViewInput): TemplateResult {
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
        ${input.links.map(
          (link) =>
            html`<tr>
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
                  <button class="button quiet" @click=${() => input.onOpenEditor(link)}>Edit</button
                  ><button class="button quiet" @click=${() => input.onShowRequests(link)}>
                    Requests</button
                  ><button class="button quiet" @click=${() => input.onPreview(link)}>
                    Preview</button
                  >${link.revokedAt === null
                    ? html`<button class="button quiet" @click=${() => input.onRevoke(link)}>
                        Revoke
                      </button>`
                    : nothing}
                </div>
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function renderRequests(input: SharingPanelViewInput): TemplateResult | typeof nothing {
  if (input.requestLinkId === null) return nothing;
  return html`<section class="surface stack">
    <h2>Access requests</h2>
    ${input.requests.length === 0
      ? html`<p class="muted">No requests for this link.</p>`
      : input.requests.map(
          (request) =>
            html`<div class="page-head">
              <div>
                <strong>${request.requestedEmail}</strong><br /><span
                  class="badge ${request.status}"
                  >${request.status}</span
                >
              </div>
              ${request.status === 'pending'
                ? html`<div class="actions">
                    <button
                      class="button secondary"
                      @click=${() => input.onDecide(request, 'denied')}
                    >
                      Deny</button
                    ><button class="button" @click=${() => input.onDecide(request, 'approved')}>
                      Approve
                    </button>
                  </div>`
                : nothing}
            </div>`,
        )}
  </section>`;
}

function renderEditor(input: SharingPanelViewInput): TemplateResult {
  const link = input.editing;
  const specific = isSpecificAudience(link);
  const allowed = [
    ...(link?.allowedEmails ?? []),
    ...(link?.allowedDomains ?? []).map((domain) => `@${domain}`),
  ].join('\n');
  return html`<dialog id="link-dialog" aria-labelledby="link-title">
    <form class="dialog-body editor-dialog" @submit=${input.onSaveLink}>
      <div class="dialog-scroll stack">
        <p class="eyebrow">Access control</p>
        <h2 id="link-title">${link === null ? 'Create share link' : `Edit “${link.name}”`}</h2>
        ${input.createdUrl
          ? html`<div class="notice">
              <strong>Link ready.</strong><br /><span class="mono">${input.createdUrl}</span>
              <div class="actions">
                <button class="button secondary" type="button" @click=${input.onCopyCreated}>
                  Copy link
                </button>
              </div>
            </div>`
          : nothing}
        <div class="field">
          <label for="link-name">Link name</label
          ><input id="link-name" name="name" required maxlength="160" .value=${link?.name ?? ''} />
        </div>
        <fieldset class="stack">
          <legend>Who can open it?</legend>
          <label class="choice"
            ><input type="radio" name="audience" value="anyone" ?checked=${!specific} /><span
              ><strong>Anyone with the link</strong><br /><small
                >Anonymous viewer session.</small
              ></span
            ></label
          >
          <label class="choice"
            ><input type="radio" name="audience" value="specific" ?checked=${specific} /><span
              ><strong>Specific emails or domains</strong><br /><small
                >Enter one per line below.</small
              ></span
            ></label
          >
        </fieldset>
        <div class="field">
          <label for="allowed">Allowed emails or domains</label
          ><textarea
            id="allowed"
            name="allowed"
            .value=${allowed}
            placeholder="buyer@example.com&#10;@example.com"
          ></textarea>
        </div>
        <label class="choice"
          ><input
            type="checkbox"
            name="require_auth"
            ?checked=${link?.accessMode === 'authenticated'}
          /><span
            ><strong>Require authentication</strong><br /><small
              >When off, matching email entry is not inbox verification and analytics label it
              Unverified.</small
            ></span
          ></label
        >
        <div class="field">
          <label for="expires-at">Expires at</label
          ><input id="expires-at" name="expires_at" type="datetime-local" />
        </div>
      </div>
      <div class="actions dialog-actions">
        <button class="button secondary" type="button" @click=${input.onCloseEditor}>Close</button
        ><button class="button" type="submit" aria-busy=${String(input.saving)}>
          ${input.saving ? 'Saving…' : 'Save link'}
        </button>
      </div>
    </form>
  </dialog>`;
}

export function isSpecificAudience(link: Pick<ShareLink, 'accessMode'> | null): boolean {
  return link !== null && link.accessMode !== 'anyone';
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
