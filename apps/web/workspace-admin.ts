import { LitElement, nothing } from 'lit';
import { ApiError, apiEmpty, apiJson, jsonBody } from './deck-api.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';
import { workspaceAdminStyles } from './workspace-admin-styles.ts';
import { renderWorkspaceAdminShell, type AdminPageState } from './workspace-admin-shell.ts';
import {
  canAdministerWorkspace,
  memberInvitationSchema,
  workspaceAdminSchema,
  workspacePolicySchema,
  type WorkspaceAdminData,
} from './workspace-admin-types.ts';
import { renderWorkspaceAdmin, type MutationFeedback } from './workspace-admin-view.ts';

class WorkspaceAdmin extends LitElement {
  static properties = {
    data: { state: true },
    pageState: { state: true },
    error: { state: true },
    memberEmail: { state: true },
    memberRole: { state: true },
    memberBusy: { state: true },
    deletingMemberId: { state: true },
    memberFeedback: { state: true },
    consentRequired: { state: true },
    retentionDays: { state: true },
    policyBusy: { state: true },
    policyFeedback: { state: true },
  };
  static styles = [productStyles, productLayoutStyles, workspaceAdminStyles];

  declare data: WorkspaceAdminData | null;
  declare pageState: AdminPageState;
  declare error: string | null;
  declare memberEmail: string;
  declare memberRole: 'admin' | 'member';
  declare memberBusy: boolean;
  declare deletingMemberId: string | null;
  declare memberFeedback: MutationFeedback | null;
  declare consentRequired: boolean;
  declare retentionDays: string;
  declare policyBusy: boolean;
  declare policyFeedback: MutationFeedback | null;

  constructor() {
    super();
    this.data = null;
    this.pageState = 'loading';
    this.error = null;
    this.memberEmail = '';
    this.memberRole = 'member';
    this.memberBusy = false;
    this.deletingMemberId = null;
    this.memberFeedback = null;
    this.consentRequired = false;
    this.retentionDays = '90';
    this.policyBusy = false;
    this.policyFeedback = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.pageState = 'loading';
    this.error = null;
    try {
      await this.refreshWorkspace();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.pageState = 'signed-out';
      else if (error instanceof ApiError && error.status === 403) this.pageState = 'forbidden';
      else {
        this.pageState = 'error';
        this.error = errorMessage(error, 'Could not load workspace settings');
      }
    }
  }

  private async refreshWorkspace(): Promise<void> {
    const data = await apiJson('/v1/workspace', workspaceAdminSchema);
    if (!canAdministerWorkspace(data.workspace.role)) {
      this.pageState = 'forbidden';
      return;
    }
    this.data = data;
    this.consentRequired = data.workspace.analyticsConsentRequired;
    this.retentionDays = String(data.workspace.analyticsRetentionDays);
    this.pageState = 'ready';
  }

  private updateMemberEmail(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement)
      this.memberEmail = event.currentTarget.value;
  }

  private updateMemberRole(event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    if (event.currentTarget.value === 'admin' || event.currentTarget.value === 'member') {
      this.memberRole = event.currentTarget.value;
    }
  }

  private async inviteMember(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const invitation = memberInvitationSchema.safeParse({
      email: this.memberEmail,
      role: this.memberRole,
    });
    if (!invitation.success) {
      this.memberFeedback = { kind: 'error', message: 'Enter a valid email address.' };
      return;
    }
    this.memberBusy = true;
    this.memberFeedback = null;
    try {
      await apiEmpty('/v1/workspace/members', jsonBody(invitation.data));
      this.memberEmail = '';
      await this.refreshAfterMutation('Member added.');
    } catch (error) {
      this.memberFeedback = { kind: 'error', message: errorMessage(error, 'Could not add member') };
    } finally {
      this.memberBusy = false;
    }
  }

  private async removeMember(memberId: string): Promise<void> {
    this.deletingMemberId = memberId;
    this.memberFeedback = null;
    try {
      await apiEmpty(`/v1/workspace/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
      await this.refreshAfterMutation('Member removed.');
    } catch (error) {
      this.memberFeedback = {
        kind: 'error',
        message: errorMessage(error, 'Could not remove member'),
      };
    } finally {
      this.deletingMemberId = null;
    }
  }

  private updateConsent(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) {
      this.consentRequired = event.currentTarget.checked;
    }
  }

  private updateRetention(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement)
      this.retentionDays = event.currentTarget.value;
  }

  private async savePolicy(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const policy = workspacePolicySchema.safeParse({
      consentRequired: this.consentRequired,
      retentionDays: Number(this.retentionDays),
    });
    if (!policy.success) {
      this.policyFeedback = {
        kind: 'error',
        message: 'Retention must be between 30 and 2555 days.',
      };
      return;
    }
    this.policyBusy = true;
    this.policyFeedback = null;
    try {
      await apiEmpty('/v1/workspace/policy', {
        method: 'PUT',
        body: JSON.stringify(policy.data),
      });
      try {
        await this.refreshWorkspace();
        this.policyFeedback = { kind: 'success', message: 'Policy saved.' };
      } catch {
        this.policyFeedback = {
          kind: 'success',
          message: 'Policy saved. Refresh to see the latest settings.',
        };
      }
    } catch (error) {
      this.policyFeedback = {
        kind: 'error',
        message: errorMessage(error, 'Could not save policy'),
      };
    } finally {
      this.policyBusy = false;
    }
  }

  private async refreshAfterMutation(message: string): Promise<void> {
    try {
      await this.refreshWorkspace();
      this.memberFeedback = { kind: 'success', message };
    } catch {
      this.memberFeedback = {
        kind: 'success',
        message: `${message} Refresh to see the latest roster.`,
      };
    }
  }

  private async logout(): Promise<void> {
    await apiEmpty('/auth/logout', { method: 'POST' });
    location.assign('/');
  }

  render() {
    const content =
      this.data === null
        ? nothing
        : renderWorkspaceAdmin({
            data: this.data,
            memberEmail: this.memberEmail,
            memberRole: this.memberRole,
            memberBusy: this.memberBusy,
            deletingMemberId: this.deletingMemberId,
            memberFeedback: this.memberFeedback,
            consentRequired: this.consentRequired,
            retentionDays: this.retentionDays,
            policyBusy: this.policyBusy,
            policyFeedback: this.policyFeedback,
            onInvite: (event) => void this.inviteMember(event),
            onEmail: (event) => this.updateMemberEmail(event),
            onRole: (event) => this.updateMemberRole(event),
            onRemove: (memberId) => void this.removeMember(memberId),
            onPolicy: (event) => void this.savePolicy(event),
            onConsent: (event) => this.updateConsent(event),
            onRetention: (event) => this.updateRetention(event),
          });
    return renderWorkspaceAdminShell({
      state: this.pageState,
      workspaceName: this.data?.workspace.name ?? null,
      error: this.error,
      content,
      onRetry: () => void this.load(),
      onLogout: () => void this.logout(),
    });
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code === 'forbidden') {
    return 'You do not have permission to make this change.';
  }
  if (error instanceof ApiError && error.code === 'not_found') {
    return 'No workspace user was found for that email.';
  }
  return error instanceof Error ? error.message : fallback;
}

customElements.define('workspace-admin', WorkspaceAdmin);
