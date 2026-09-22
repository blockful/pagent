import { html, nothing, type TemplateResult } from 'lit';
import type { ShareLink } from './deck-types.ts';

export type SharingEditorViewInput = {
  readonly editing: ShareLink | null;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly createdUrl: string | null;
  readonly onCloseEditor: () => void;
  readonly onSaveLink: (event: Event) => void;
  readonly onCopyCreated: () => void;
};

export function renderSharingEditor(input: SharingEditorViewInput): TemplateResult {
  const link = input.editing;
  const accessMode = link?.accessMode ?? 'anyone';
  const allowed = [
    ...(link?.allowedEmails ?? []),
    ...(link?.allowedDomains ?? []).map((domain) => `@${domain}`),
  ].join('\n');
  return html`<dialog
    id="link-dialog"
    aria-labelledby="link-title"
    @cancel=${(event: Event) => input.saving && event.preventDefault()}
  >
    <form
      class="dialog-body editor-dialog"
      aria-busy=${String(input.saving)}
      @submit=${input.onSaveLink}
    >
      <div class="dialog-scroll stack">
        <p class="eyebrow">Access control</p>
        <h2 id="link-title">${link === null ? 'Create share link' : `Edit “${link.name}”`}</h2>
        ${input.createdUrl
          ? html`<div class="notice">
              <strong>Link ready.</strong><br /><span class="mono">${input.createdUrl}</span>
              <div class="actions">
                <button
                  class="button secondary"
                  type="button"
                  ?disabled=${input.saving}
                  @click=${input.onCopyCreated}
                >
                  Copy link
                </button>
              </div>
            </div>`
          : nothing}
        <div class="field">
          <label for="link-name">Link name</label
          ><input
            id="link-name"
            name="name"
            required
            maxlength="160"
            ?disabled=${input.saving}
            .value=${link?.name ?? ''}
          />
        </div>
        <fieldset class="stack">
          <legend>Who can open it?</legend>
          <label class="choice"
            ><input
              type="radio"
              name="access_mode"
              value="anyone"
              ?checked=${accessMode === 'anyone'}
              ?disabled=${input.saving}
            /><span
              ><strong>Anyone with the link</strong><br /><small
                >Anonymous viewer session.</small
              ></span
            ></label
          >
          <label class="choice"
            ><input
              type="radio"
              name="access_mode"
              value="allowed_email"
              ?checked=${accessMode === 'allowed_email'}
              ?disabled=${input.saving}
            /><span
              ><strong>Allowed email</strong><br /><small
                >Anyone who knows an allowed address can open it. No inbox verification; viewers are
                labeled Unverified.</small
              ></span
            ></label
          >
          <label class="choice"
            ><input
              type="radio"
              name="access_mode"
              value="authenticated"
              ?checked=${accessMode === 'authenticated'}
              ?disabled=${input.saving}
            /><span
              ><strong>Authenticated viewer</strong><br /><small
                >Viewer signs in with an allowed email or domain. Recommended for confidential
                material.</small
              ></span
            ></label
          >
        </fieldset>
        <div class="field">
          <label for="allowed">Allowed emails or domains for restricted access</label
          ><textarea
            id="allowed"
            name="allowed"
            ?disabled=${input.saving}
            .value=${allowed}
            placeholder="buyer@example.com&#10;@example.com"
          ></textarea>
        </div>
        <div class="field">
          <label for="expires-at">Expires at</label
          ><input
            id="expires-at"
            name="expires_at"
            type="datetime-local"
            ?disabled=${input.saving}
          />
        </div>
      </div>
      ${input.saveError
        ? html`<p class="notice error" role="alert">${input.saveError}</p>`
        : nothing}
      <div class="actions dialog-actions">
        <button
          class="button secondary"
          type="button"
          ?disabled=${input.saving}
          @click=${input.onCloseEditor}
        >
          Close</button
        ><button
          class="button"
          type="submit"
          ?disabled=${input.saving}
          aria-busy=${String(input.saving)}
        >
          ${input.saving ? 'Saving…' : 'Save link'}
        </button>
      </div>
    </form>
  </dialog>`;
}

export function isSpecificAudience(link: Pick<ShareLink, 'accessMode'> | null): boolean {
  return link !== null && link.accessMode !== 'anyone';
}
