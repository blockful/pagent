import { html, nothing, type TemplateResult } from 'lit';
import type { AccessSettings, AnalyticsAudience, AuditEvent } from './deck-types.ts';

type AccessPanelViewInput = {
  readonly settings: AccessSettings | null;
  readonly audit: readonly AuditEvent[];
  readonly visibility: AccessSettings['analyticsVisibility'];
  readonly subjectIds: readonly string[];
  readonly contentIds: readonly string[];
  readonly audience: AnalyticsAudience | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly onVisibilityChange: (event: Event) => void;
  readonly onToggleSubject: (event: Event) => void;
  readonly onToggleContent: (event: Event) => void;
  readonly onPreviewAudience: () => void;
  readonly onSaveAudience: () => void;
  readonly onSaveContent: () => void;
  readonly onAddMember: (event: Event) => void;
  readonly onRemoveMember: (memberId: string, email: string) => void;
  readonly onSavePolicy: (event: Event) => void;
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
        <h2>View deck content</h2>
        <p class="muted">Content access never grants analytics or link management.</p>
        ${renderMembers(input)}
        <div class="actions">
          <button class="button" @click=${input.onSaveContent}>Save content access</button>
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
          <button class="button secondary" @click=${input.onPreviewAudience}>
            Preview named audience</button
          ><button
            class="button"
            ?disabled=${input.audience === null}
            @click=${input.onSaveAudience}
          >
            Save audience
          </button>
        </div>
        ${input.audience
          ? html`<div class="notice">
              <strong>Effective audience</strong><br />${input.audience.audience
                .map((member) => member.email)
                .join(', ') || 'Deck owner only'}
            </div>`
          : nothing}
      </section>
    </div>
    <div class="detail-grid">
      <form class="surface stack" @submit=${input.onAddMember}>
        <h2>Add workspace member</h2>
        <div class="field">
          <label for="member-email">Existing Pagent account email</label
          ><input id="member-email" name="email" type="email" required />
        </div>
        <div class="field">
          <label for="member-role">Role</label
          ><select id="member-role" name="role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button class="button" type="submit">Add member</button>
      </form>
      <form class="surface stack" @submit=${input.onSavePolicy}>
        <h2>Privacy & retention</h2>
        <label class="choice"
          ><input
            type="checkbox"
            name="consent"
            ?checked=${input.settings.analyticsConsentRequired}
          /><span
            ><strong>Require analytics consent</strong><br /><small
              >Declining never blocks access; only a minimal audit event remains.</small
            ></span
          ></label
        >
        <div class="field">
          <label for="retention">Retention days</label
          ><input
            id="retention"
            name="retention"
            type="number"
            min="30"
            max="2555"
            .value=${String(input.settings.analyticsRetentionDays)}
          />
        </div>
        <button class="button" type="submit">Save policy</button>
      </form>
    </div>
    <section class="surface stack">
      <h2>Audit log</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Actor</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            ${input.audit.map(
              (event) =>
                html`<tr>
                  <td data-label="Action" class="mono">${event.action}</td>
                  <td data-label="Actor">${event.actorEmail ?? 'Viewer / system'}</td>
                  <td data-label="When">${formatDate(event.createdAt)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>
  </div>`;
}

function renderMembers(input: AccessPanelViewInput): TemplateResult {
  return html`${input.settings?.members
    .filter((member) => member.role !== 'owner')
    .map(
      (member) =>
        html`<div class="page-head">
          <label class="choice"
            ><input
              type="checkbox"
              .value=${member.id}
              ?checked=${input.contentIds.includes(member.id)}
              @change=${input.onToggleContent}
            /><span
              ><strong>${member.email}</strong><br /><small
                >${member.role} · ${member.status}</small
              ></span
            ></label
          >
          <button
            class="button quiet"
            @click=${() => input.onRemoveMember(member.id, member.email)}
          >
            Remove
          </button>
        </div>`,
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
