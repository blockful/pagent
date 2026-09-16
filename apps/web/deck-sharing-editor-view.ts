import { html, nothing, type TemplateResult } from 'lit';
import type { ShareLink } from './deck-types.ts';

export type SharingEditorViewInput = {
  readonly editing: ShareLink | null;
  readonly saving: boolean;
  readonly createdUrl: string | null;
  readonly onCloseEditor: () => void;
  readonly onSaveLink: (event: Event) => void;
  readonly onCopyCreated: () => void;
};

export function renderSharingEditor(input: SharingEditorViewInput): TemplateResult {
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
