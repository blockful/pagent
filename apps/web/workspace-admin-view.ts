import { html, type TemplateResult } from 'lit';
import { renderWorkspaceActivity } from './workspace-admin-activity-view.ts';
import { renderWorkspaceMembers } from './workspace-admin-members-view.ts';
import { renderWorkspacePages } from './workspace-admin-pages-view.ts';
import { renderWorkspacePolicy } from './workspace-admin-policy-view.ts';
import type { WorkspaceAdminData } from './workspace-admin-types.ts';

export interface MutationFeedback {
  readonly kind: 'success' | 'error';
  readonly message: string;
}

export interface WorkspaceAdminViewModel {
  readonly data: WorkspaceAdminData;
  readonly memberEmail: string;
  readonly memberRole: 'admin' | 'member';
  readonly memberBusy: boolean;
  readonly deletingMemberId: string | null;
  readonly memberFeedback: MutationFeedback | null;
  readonly consentRequired: boolean;
  readonly retentionDays: string;
  readonly policyBusy: boolean;
  readonly policyFeedback: MutationFeedback | null;
  readonly onInvite: (event: SubmitEvent) => void;
  readonly onEmail: (event: Event) => void;
  readonly onRole: (event: Event) => void;
  readonly onRemove: (memberId: string) => void;
  readonly onPolicy: (event: SubmitEvent) => void;
  readonly onConsent: (event: Event) => void;
  readonly onRetention: (event: Event) => void;
}

export function renderWorkspaceAdmin(view: WorkspaceAdminViewModel): TemplateResult {
  return html`
    <header class="page-head">
      <div>
        <p class="eyebrow">Workspace administration</p>
        <h1>${view.data.workspace.name}</h1>
        <p class="lede">
          Manage membership, privacy defaults, and the activity trail for this workspace.
        </p>
      </div>
      <span class="badge active">${roleLabel(view.data.workspace.role)}</span>
    </header>
    ${renderSummary(view.data)} ${renderWorkspacePages(view.data)}
    <div class="admin-grid">
      <div class="stack">${renderWorkspaceMembers(view)} ${renderWorkspaceActivity(view.data)}</div>
      <div class="stack">${renderWorkspacePolicy(view)}</div>
    </div>
  `;
}

function renderSummary(data: WorkspaceAdminData): TemplateResult {
  const activeMembers = data.members.filter((member) => member.status === 'active').length;
  return html`<section class="summary-grid" aria-label="Workspace summary">
    <div class="summary-card">
      <span class="caption">Published pages</span><strong>${data.workspace.pageCount}</strong>
    </div>
    <div class="summary-card">
      <span class="caption">Active members</span><strong>${activeMembers}</strong>
    </div>
    <div class="summary-card">
      <span class="caption">Analytics retention</span
      ><strong>${data.workspace.analyticsRetentionDays} days</strong>
    </div>
  </section>`;
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
