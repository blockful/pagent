import { html, type TemplateResult } from 'lit';
import type { WorkspaceAdminData } from './workspace-admin-types.ts';

export function renderWorkspacePages(data: WorkspaceAdminData): TemplateResult {
  return html`<section class="surface stack pages-section" aria-labelledby="pages-title">
    <div class="section-head">
      <div>
        <h2 id="pages-title">Presentation pages</h2>
        <p class="muted">
          Workspace metadata only. Administration does not grant access to page content or viewer
          analytics.
        </p>
      </div>
      <span class="badge">${data.pages.length} recent</span>
    </div>
    ${data.pages.length === 0
      ? html`<div class="compact-empty">
          <strong>No presentation pages</strong
          ><span>Published page metadata will appear here.</span>
        </div>`
      : html`<div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Owner</th>
                <th>Latest sender</th>
                <th>Status</th>
                <th>Links</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${data.pages.map(
                (page) =>
                  html`<tr>
                    <td data-label="Page"><strong>${page.title}</strong></td>
                    <td data-label="Owner">${page.ownerEmail}</td>
                    <td data-label="Latest sender">${page.latestSenderEmail ?? '—'}</td>
                    <td data-label="Status">
                      <span class=${`badge ${page.status}`}>${page.status}</span>
                    </td>
                    <td data-label="Links" class="mono">${page.linkCount}</td>
                    <td data-label="Updated">${formatDate(page.updatedAt)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`}
  </section>`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}
