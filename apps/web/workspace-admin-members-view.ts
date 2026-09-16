import { html, nothing, type TemplateResult } from 'lit';
import type { WorkspaceMember } from './workspace-admin-types.ts';
import type { MutationFeedback, WorkspaceAdminViewModel } from './workspace-admin-view.ts';

export function renderWorkspaceMembers(view: WorkspaceAdminViewModel): TemplateResult {
  return html`<section class="surface stack" aria-labelledby="members-title">
    <div class="section-head">
      <div>
        <h2 id="members-title">Members</h2>
        <p class="muted">Add an existing Pagent user by email.</p>
      </div>
      <span class="badge">${view.data.members.length}</span>
    </div>
    <form id="member-form" class="inline-form" @submit=${view.onInvite}>
      <div class="field">
        <label for="member-email">Email address</label>
        <input
          id="member-email"
          type="email"
          autocomplete="email"
          required
          .value=${view.memberEmail}
          @input=${view.onEmail}
        />
      </div>
      <div class="field">
        <label for="member-role">Role</label>
        <select id="member-role" .value=${view.memberRole} @change=${view.onRole}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button
        class="button"
        type="submit"
        ?disabled=${view.memberBusy}
        aria-busy=${view.memberBusy ? 'true' : 'false'}
      >
        ${view.memberBusy ? 'Adding…' : 'Add member'}
      </button>
    </form>
    ${renderFeedback(view.memberFeedback)} ${renderMemberTable(view)}
  </section>`;
}

function renderMemberTable(view: WorkspaceAdminViewModel): TemplateResult {
  if (view.data.members.length === 0) {
    return html`<div class="compact-empty">
      <strong>No members yet</strong><span>Add the first workspace member above.</span>
    </div>`;
  }
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Member</th>
          <th>Role</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${view.data.members.map((member) => renderMember(member, view))}
      </tbody>
    </table>
  </div>`;
}

function renderMember(member: WorkspaceMember, view: WorkspaceAdminViewModel): TemplateResult {
  const deleting = view.deletingMemberId === member.id;
  return html`<tr>
    <td data-label="Member">
      <span class="member-name">
        <strong>${member.email}</strong>
        ${member.handle ? html`<small>@${member.handle}</small>` : nothing}
      </span>
    </td>
    <td data-label="Role">${roleLabel(member.role)}</td>
    <td data-label="Status"><span class=${`badge ${member.status}`}>${member.status}</span></td>
    <td data-label="Actions" class="row-action">
      ${member.role === 'owner'
        ? html`<span class="caption">Workspace owner</span>`
        : member.status !== 'active'
          ? html`<span class="caption">No access</span>`
          : html`<button
              class="button quiet"
              type="button"
              ?disabled=${view.deletingMemberId !== null || view.memberBusy}
              aria-busy=${deleting ? 'true' : 'false'}
              @click=${() => confirmRemoval(member, view)}
            >
              ${deleting ? 'Removing…' : 'Remove'}
            </button>`}
    </td>
  </tr>`;
}

function renderFeedback(feedback: MutationFeedback | null): TemplateResult | typeof nothing {
  if (feedback === null) return nothing;
  return html`<p
    class=${`notice ${feedback.kind === 'error' ? 'error' : ''}`}
    role=${feedback.kind === 'error' ? 'alert' : 'status'}
  >
    ${feedback.message}
  </p>`;
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function confirmRemoval(member: WorkspaceMember, view: WorkspaceAdminViewModel): void {
  const confirmed = globalThis.confirm(
    `Remove ${member.email} from this workspace? They will lose page and analytics access.`,
  );
  if (confirmed) view.onRemove(member.id);
}
