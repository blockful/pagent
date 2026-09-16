import { html, nothing, type TemplateResult } from 'lit';
import type { MutationFeedback, WorkspaceAdminViewModel } from './workspace-admin-view.ts';

export function renderWorkspacePolicy(view: WorkspaceAdminViewModel): TemplateResult {
  return html`<section class="surface stack" aria-labelledby="privacy-title">
      <div>
        <h2 id="privacy-title">Privacy & retention</h2>
        <p class="muted">Workspace defaults apply to engagement analytics on every page.</p>
      </div>
      <form id="policy-form" class="stack" @submit=${view.onPolicy}>
        <div class="policy-fields">
          <label class="choice">
            <input type="checkbox" .checked=${view.consentRequired} @change=${view.onConsent} />
            <span
              ><strong>Require viewer consent</strong><br /><small
                >Analytics stay off until a viewer opts in.</small
              ></span
            >
          </label>
          <div class="field">
            <label for="retention-days">Retention days</label>
            <input
              id="retention-days"
              type="number"
              min="30"
              max="2555"
              required
              .value=${view.retentionDays}
              @input=${view.onRetention}
            />
          </div>
        </div>
        ${renderFeedback(view.policyFeedback)}
        <div class="actions">
          <button
            class="button"
            type="submit"
            ?disabled=${view.policyBusy}
            aria-busy=${view.policyBusy ? 'true' : 'false'}
          >
            ${view.policyBusy ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </form>
    </section>
    ${renderWorkspaceStructure(view)}`;
}

function renderWorkspaceStructure(view: WorkspaceAdminViewModel): TemplateResult {
  const { teams, workspace } = view.data;
  return html`<section class="surface stack" aria-labelledby="structure-title">
    <div>
      <h2 id="structure-title">Workspace structure</h2>
      <p class="muted">Teams and verified domains are read-only here.</p>
    </div>
    <div class="stack">
      <h3>Teams</h3>
      ${teams.length === 0
        ? html`<p class="muted">No teams configured.</p>`
        : html`<ul class="summary-list">
            ${teams.map(
              (team) =>
                html`<li>
                  <strong>${team.name}</strong
                  ><span class="caption"
                    >${team.memberIds.length}
                    ${team.memberIds.length === 1 ? 'member' : 'members'}</span
                  >
                </li>`,
            )}
          </ul>`}
    </div>
    <div class="stack">
      <h3>Verified domains</h3>
      ${workspace.verifiedDomains.length === 0
        ? html`<p class="muted">No verified domains.</p>`
        : html`<div class="domain-list">
            ${workspace.verifiedDomains.map(
              (domain) => html`<span class="badge authenticated">${domain}</span>`,
            )}
          </div>`}
    </div>
  </section>`;
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
