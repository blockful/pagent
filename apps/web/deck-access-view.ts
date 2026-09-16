import { html, nothing, type TemplateResult } from 'lit';
import type { AccessSettings, AnalyticsAudience } from './deck-types.ts';

type AccessPanelViewInput = {
  readonly settings: AccessSettings | null;
  readonly visibility: AccessSettings['analyticsVisibility'];
  readonly subjectIds: readonly string[];
  readonly contentIds: readonly string[];
  readonly audience: AnalyticsAudience | null;
  readonly loading: boolean;
  readonly saving: 'audience' | 'content' | 'preview' | null;
  readonly error: string | null;
  readonly message: string | null;
  readonly onVisibilityChange: (event: Event) => void;
  readonly onToggleSubject: (event: Event) => void;
  readonly onToggleContent: (event: Event) => void;
  readonly onPreviewAudience: () => void;
  readonly onSaveAudience: () => void;
  readonly onSaveContent: () => void;
};

export function renderAccessPanel(input: AccessPanelViewInput): TemplateResult {
  if (input.loading)
    return html`<div class="surface stack" aria-busy="true">
      <span class="loading-line"></span><span class="loading-line"></span>
    </div>`;
  if (input.error || input.settings === null)
    return html`<p class="notice error" role="alert">
      ${input.error ?? 'Access settings unavailable'}
    </p>`;
  return html`<div class="stack">
    ${input.message ? html`<p class="notice" role="status">${input.message}</p>` : nothing}
    <div class="detail-grid">
      <section class="surface stack">
        <p class="eyebrow">Separate permission</p>
        <h2>View page content</h2>
        <p class="muted">Content access never grants analytics or link management.</p>
        ${renderMembers(input)}
        <div class="actions">
          <button class="button" ?disabled=${input.saving !== null} @click=${input.onSaveContent}>
            ${input.saving === 'content' ? 'Saving…' : 'Save content access'}
          </button>
        </div>
      </section>
      <section class="surface stack">
        <p class="eyebrow">Private by default</p>
        <h2>View analytics</h2>
        <div class="field">
          <label for="visibility">Visibility</label
          ><select id="visibility" .value=${input.visibility} @change=${input.onVisibilityChange}>
            <option value="private">Private</option>
            <option value="selected">Selected people</option>
            <option value="team">Team</option>
            <option value="workspace">Workspace</option>
          </select>
        </div>
        ${renderSubjects(input)}
        <div class="actions">
          <button
            class="button secondary"
            ?disabled=${input.saving !== null}
            @click=${input.onPreviewAudience}
          >
            ${input.saving === 'preview' ? 'Previewing…' : 'Preview named audience'}</button
          ><button
            class="button"
            ?disabled=${input.audience === null || input.saving !== null}
            @click=${input.onSaveAudience}
          >
            ${input.saving === 'audience' ? 'Saving…' : 'Save audience'}
          </button>
        </div>
        ${input.audience
          ? html`<div class="notice">
              <strong>Effective audience</strong><br />${input.audience.audience
                .map((member) => member.email)
                .join(', ') || 'Page owner only'}
            </div>`
          : nothing}
      </section>
    </div>
    <p class="notice">
      Workspace members, retention, and audit history are managed in <a href="/admin">Admin</a>.
    </p>
  </div>`;
}

function renderMembers(input: AccessPanelViewInput): TemplateResult {
  const members = input.settings?.members.filter((member) => member.role !== 'owner') ?? [];
  if (members.length === 0) {
    return html`<p class="notice">No workspace members are available. Add them in Admin first.</p>`;
  }
  return html`${members.map(
    (member) =>
      html`<label class="choice"
        ><input
          type="checkbox"
          .value=${member.id}
          ?checked=${input.contentIds.includes(member.id)}
          ?disabled=${member.status !== 'active'}
          @change=${input.onToggleContent}
        /><span
          ><strong>${member.email}</strong><br /><small
            >${member.role} · ${member.status}</small
          ></span
        ></label
      >`,
  )}`;
}

function renderSubjects(input: AccessPanelViewInput): TemplateResult {
  if (input.visibility === 'private')
    return html`<p class="notice">
      Owner plus each active link creator for only their link analytics.
    </p>`;
  if (input.visibility === 'workspace')
    return html`<p class="notice">
      Every active authenticated workspace member. Email suffix alone never grants access.
    </p>`;
  const choices =
    input.visibility === 'team'
      ? (input.settings?.teams ?? [])
      : (input.settings?.members ?? []).filter(
          (member) => member.role !== 'owner' && member.status === 'active',
        );
  return html`<div class="stack">
    ${choices.map(
      (choice) =>
        html`<label class="choice"
          ><input
            type="checkbox"
            .value=${choice.id}
            ?checked=${input.subjectIds.includes(choice.id)}
            @change=${input.onToggleSubject}
          /><span><strong>${'email' in choice ? choice.email : choice.name}</strong></span></label
        >`,
    )}
  </div>`;
}
