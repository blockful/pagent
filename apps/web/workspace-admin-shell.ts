import { html, type TemplateResult } from 'lit';
import { loginUrl } from './deck-api.ts';

export type AdminPageState = 'loading' | 'ready' | 'signed-out' | 'forbidden' | 'error';

interface WorkspaceAdminShellInput {
  readonly state: AdminPageState;
  readonly workspaceName: string | null;
  readonly error: string | null;
  readonly content: unknown;
  readonly onRetry: () => void;
  readonly onLogout: () => void;
}

export function renderWorkspaceAdminShell(input: WorkspaceAdminShellInput): TemplateResult {
  if (input.state === 'signed-out') return renderSignedOut();
  return html`<a class="skip-link" href="#main">Skip to workspace administration</a>
    <div class="shell product-shell">
      <header class="topbar">
        <a class="brand" href="/"><span class="brand-mark"></span>Pagent</a>
        <div class="cluster">
          <span class="caption">${input.workspaceName ?? 'Workspace'}</span>
          <button class="button quiet" type="button" @click=${input.onLogout}>Sign out</button>
        </div>
      </header>
      <product-navigation current="admin"></product-navigation>
      <main class="page" id="main">${renderPage(input)}</main>
    </div>`;
}

function renderPage(input: WorkspaceAdminShellInput): unknown {
  if (input.state === 'loading') {
    return html`<section
      class="surface stack"
      aria-busy="true"
      aria-label="Loading workspace settings"
    >
      ${[1, 2, 3, 4].map(() => html`<span class="loading-line"></span>`)}
    </section>`;
  }
  if (input.state === 'forbidden') {
    return html`<section class="surface empty page-error">
      <p class="eyebrow">Administrator access</p>
      <h1>This area is for workspace administrators.</h1>
      <p class="lede">
        Ask an owner or administrator for access, or return to your published pages.
      </p>
      <a class="button" href="/pages">Back to pages</a>
    </section>`;
  }
  if (input.state === 'error') {
    return html`<section class="surface empty page-error">
      <p class="eyebrow">Workspace unavailable</p>
      <h1>Settings could not be loaded.</h1>
      <p class="lede">${input.error}</p>
      <button class="button" type="button" @click=${input.onRetry}>Try again</button>
    </section>`;
  }
  return input.content;
}

function renderSignedOut(): TemplateResult {
  return html`<div class="shell">
    <main class="page">
      <section class="surface empty page-error">
        <p class="eyebrow">Private workspace</p>
        <h1>Sign in to administer your workspace.</h1>
        <p class="lede">
          Membership, privacy policy, and audit history are available only to workspace
          administrators.
        </p>
        <a class="button" href=${loginUrl('/admin')}>Continue securely</a>
      </section>
    </main>
  </div>`;
}
