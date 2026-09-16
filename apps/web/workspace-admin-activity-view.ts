import { html, nothing, type TemplateResult } from 'lit';
import type { WorkspaceAdminData, WorkspaceAuditEvent } from './workspace-admin-types.ts';

export function renderWorkspaceActivity(data: WorkspaceAdminData): TemplateResult {
  return html`<section class="surface stack" aria-labelledby="audit-title">
    <div>
      <h2 id="audit-title">Workspace activity</h2>
      <p class="muted">Administrative changes across the workspace.</p>
    </div>
    ${data.recentAuditEvents.length === 0
      ? html`<div class="compact-empty">
          <strong>No workspace activity yet</strong
          ><span>Membership and policy changes will appear here.</span>
        </div>`
      : html`<div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Activity</th>
                <th>Actor</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              ${data.recentAuditEvents.map(renderAuditEvent)}
            </tbody>
          </table>
        </div>`}
  </section>`;
}

function renderAuditEvent(event: WorkspaceAuditEvent): TemplateResult {
  const detail = auditDetail(event.details);
  return html`<tr>
    <td data-label="Activity">
      <div class="audit-action">${actionLabel(event.action)}</div>
      ${detail ? html`<div class="audit-detail">${detail}</div>` : nothing}
    </td>
    <td data-label="Actor">${event.actorEmail ?? 'System'}</td>
    <td data-label="When">${formatDate(event.createdAt)}</td>
  </tr>`;
}

function actionLabel(action: string): string {
  return action
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._]/g, ' ')
    .replace(/\bdeck\b/gi, 'page')
    .toLowerCase();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function auditDetail(details: unknown): string {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return '';
  return Object.entries(details)
    .filter((entry): entry is [string, string | number | boolean] =>
      ['string', 'number', 'boolean'].includes(typeof entry[1]),
    )
    .map(([key, value]) => `${actionLabel(key)}: ${String(value)}`)
    .join(' · ');
}
