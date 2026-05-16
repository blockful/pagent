import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, css, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import * as v0_9 from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9'; // registers <a2ui-surface>
import './home'; // registers <home-page>
import './components-showcase'; // registers <components-showcase>
import { assertCatalogsAllowed } from './spec-guard.js';
import { nextPollDelay, pollTimeoutMessage } from './poll-backoff.js';
import { createSandboxedIframe } from './html-renderer.js';

/** Hard-coded allowlist of catalog URLs the renderer is permitted to use. */
const ALLOWED_CATALOG_IDS = [basicCatalog.id] as const;

type PageFormat = 'a2ui' | 'html';
type PageState = 'open' | 'submitted' | 'received';
type PageResponse = {
  spec: unknown;
  format?: PageFormat; // optional for forward-compat with older API responses
  state: PageState;
  result: unknown | null;
  expires_at: number | string;
};

const pageId = location.pathname.replace(/^\/+/, '').split('/')[0];

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// Backoff: 2s → 4s → 8s → 16s → 30s (capped). Across the 60s POLL_TIMEOUT_MS
// window, this fires ~6 polls instead of the 30 a fixed 2s cadence would.
const POLL_INITIAL_MS = 2000;
const POLL_MAX_MS = 30_000;
const POLL_BACKOFF_FACTOR = 2;
const POLL_TIMEOUT_MS = 60_000;

class AgentUIApp extends SignalWatcher(LitElement) {
  static properties = {
    status: { state: true },
    error: { state: true },
    submitError: { state: true },
    awaiting: { state: true },
    awaitingMessage: { state: true },
    awaitingStalled: { state: true },
    format: { state: true },
    htmlBody: { state: true },
  };

  static styles = css`
    :host {
      display: block;
    }
    .status {
      color: var(--muted, #777);
      text-align: center;
      padding: 24px;
      font-size: 14px;
    }
    .pending {
      display: flex;
      flex-direction: column;
      gap: 16px;
      align-items: center;
      padding: 64px 16px;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid rgba(127, 127, 127, 0.2);
      border-left-color: var(--primary, #5154b3);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    .small-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(127, 127, 127, 0.25);
      border-left-color: var(--primary, #5154b3);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    .error {
      background: var(--error-bg, #ffedea);
      color: var(--error, #ba1a1a);
      padding: 16px;
      border-radius: 8px;
      margin: 16px 0;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    #surfaces {
      padding: var(--bb-grid-size-3, 12px);
      animation: fadeIn 0.35s cubic-bezier(0, 0, 0.3, 1);
      position: relative;
    }
    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }

    .surface-wrap {
      position: relative;
    }
    .surface-wrap.is-awaiting .a2ui-host {
      opacity: 0.45;
      pointer-events: none;
      filter: saturate(0.6);
      transition:
        opacity 0.2s,
        filter 0.2s;
    }
    .a2ui-host {
      transition:
        opacity 0.2s,
        filter 0.2s;
    }
    .awaiting-banner {
      position: sticky;
      top: 12px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      margin-bottom: 12px;
      border-radius: 999px;
      background: light-dark(rgba(255, 255, 255, 0.85), rgba(20, 28, 40, 0.85));
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
      color: var(--fg, #1b1b1b);
      font-size: 14px;
      width: fit-content;
      margin-left: auto;
      margin-right: auto;
      animation: fadeIn 0.25s ease-out;
    }
    .awaiting-banner.is-stalled {
      background: light-dark(rgba(255, 245, 230, 0.95), rgba(60, 40, 20, 0.85));
      color: light-dark(#7a4a00, #f6c89f);
    }
    .material-symbols {
      font-family: 'Material Symbols Outlined', sans-serif;
      font-variation-settings: 'FILL' 1;
    }
  `;

  declare status: 'connecting' | 'live' | 'closed' | 'error';
  declare error: string | null;
  declare submitError: string | null;
  declare awaiting: boolean;
  declare awaitingMessage: string;
  declare awaitingStalled: boolean;
  declare format: PageFormat;
  declare htmlBody: string | null;

  constructor() {
    super();
    this.status = 'connecting';
    this.error = null;
    this.submitError = null;
    this.awaiting = false;
    this.awaitingMessage = 'Sent — waiting for the agent…';
    this.awaitingStalled = false;
    this.format = 'a2ui';
    this.htmlBody = null;
  }

  private processor = new v0_9.MessageProcessor(
    [basicCatalog],
    async (action: v0_9.A2uiClientAction) => {
      if (this.awaiting) return; // already submitted — drop duplicate
      // Optimistic lock — the page is single-shot, so prevent further submits
      // and surface the "waiting for the agent" banner immediately.
      this.awaiting = true;
      this.submitError = null;
      this.awaitingMessage = 'Sent — waiting for the agent…';
      try {
        const res = await fetch(`${API_BASE}/${pageId}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: action.name,
            surfaceId: action.surfaceId,
            sourceComponentId: action.sourceComponentId,
            context: action.context ?? {},
            timestamp: new Date().toISOString(),
          }),
        });
        if (!res.ok) {
          console.warn('result POST failed', res.status);
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          this.submitError = body.message ?? 'Submit failed — please try again';
          this.awaiting = false;
          return;
        }
        this.startPollingForReceived();
      } catch (err) {
        console.error('result POST error', err);
        this.submitError = 'Submit failed — please check your connection and try again';
        this.awaiting = false;
      }
    },
  );

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDeadline = 0;

  connectedCallback() {
    super.connectedCallback();
    if (!pageId) {
      this.status = 'error';
      this.error = 'No page id in URL.';
      return;
    }
    void this.loadPage();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopPolling();
  }

  private async loadPage() {
    try {
      const res = await fetch(`${API_BASE}/${pageId}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 404) {
        this.status = 'error';
        this.error = 'Page not found or expired.';
        return;
      }
      if (!res.ok) {
        this.status = 'error';
        this.error = `Failed to load page (${res.status}).`;
        return;
      }
      const page = (await res.json()) as PageResponse;
      this.format = page.format ?? 'a2ui';

      if (this.format === 'html') {
        // HTML pages are pre-sanitized server-side. We trust the byte-string
        // and wrap it in a sandboxed iframe. The iframe is opaque-origin and
        // JS-free; nothing it does can reach back into this shell.
        //
        // The shell's #app container has a 640px max-width cap (set in
        // index.html for A2UI/landing layouts). HTML pages are meant to fill
        // the full viewport like a normal webpage, so we flip the `is-html`
        // class on #app to clear the cap — same escape hatch the home page
        // uses via `is-home`.
        document.getElementById('app')?.classList.add('is-html');
        this.htmlBody = typeof page.spec === 'string' ? page.spec : '';
        this.status = 'live';
        return;
      }

      // A2UI path (existing behavior).
      this.applySpec(page.spec);
      this.status = 'live';

      // If the user reloaded after submitting, restore the locked state.
      if (page.state === 'submitted') {
        this.awaiting = true;
        this.awaitingMessage = 'Sent — waiting for the agent…';
        this.startPollingForReceived();
      } else if (page.state === 'received') {
        this.awaiting = true;
        this.awaitingMessage = '✓ The agent has your input';
        // Defensive reset: a previous tick may have set awaitingStalled=true after
        // the 60s deadline. If the agent then picks up before the user navigates
        // away, the banner should drop the stalled visual state alongside the
        // message change.
        this.awaitingStalled = false;
      }
    } catch (err) {
      console.error('GET page failed', err);
      this.status = 'error';
      this.error = 'Failed to load page.';
    }
  }

  private applySpec(spec: unknown) {
    for (const id of Array.from(this.processor.model.surfacesMap.keys())) {
      this.processor.model.deleteSurface(id);
    }
    try {
      // Defense-in-depth: reject specs that reference catalogs outside the allowlist
      // before handing off to the processor. The processor already throws on unknown
      // catalogIds (outcome A), but this gate fails loudly with a user-visible message.
      assertCatalogsAllowed(spec, ALLOWED_CATALOG_IDS);
      // spec crosses the API trust boundary as unknown; cast to the typed shape so
      // the compiler will catch any future mismatch in A2UI's input contract.
      this.processor.processMessages(spec as v0_9.A2uiMessage[]);
      this.error = null;
    } catch (err) {
      console.error('processMessages failed', err, spec);
      this.error = String(err);
    }
  }

  private startPollingForReceived() {
    this.stopPolling();
    this.pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    this.awaitingStalled = false;

    const tick = async (delay: number) => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      if (Date.now() >= this.pollDeadline) {
        this.awaitingMessage = pollTimeoutMessage();
        this.awaitingStalled = true;
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/${pageId}`, {
          headers: { accept: 'application/json' },
        });
        if (res.ok) {
          const page = (await res.json()) as PageResponse;
          if (page.state === 'received') {
            this.awaitingMessage = '✓ The agent has your input';
            // Defensive reset: a previous tick may have set awaitingStalled=true after
            // the 60s deadline. If the agent then picks up before the user navigates
            // away, the banner should drop the stalled visual state alongside the
            // message change.
            this.awaitingStalled = false;
            return; // stop polling
          }
        }
        // otherwise keep polling (including 404, since the page may have been
        // evicted; we just stop on timeout/disconnect rather than spam errors).
      } catch (err) {
        console.warn('poll GET failed', err);
      }
      if (!this.isConnected || Date.now() >= this.pollDeadline) return;
      const next = nextPollDelay(delay, POLL_BACKOFF_FACTOR, POLL_MAX_MS);
      this.pollTimer = setTimeout(() => tick(next), next);
    };

    this.pollTimer = setTimeout(() => tick(POLL_INITIAL_MS), POLL_INITIAL_MS);
  }

  private stopPolling() {
    if (this.pollTimer != null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  render() {
    if (this.status === 'error') {
      return html`<div class="error">${this.error ?? 'Connection error'}</div>`;
    }
    if (this.status === 'closed') {
      return html`<div class="status">Session ended.</div>`;
    }

    if (this.format === 'html') {
      return this.renderHtml();
    }

    const surfaces = Array.from(this.processor.model.surfacesMap.entries());
    if (surfaces.length === 0) {
      return html`<div class="pending">
        <div class="spinner"></div>
        <div class="status">Loading…</div>
      </div>`;
    }
    return html`<section id="surfaces" class="surface-wrap ${this.awaiting ? 'is-awaiting' : ''}">
      ${this.submitError
        ? html`<div class="error" role="alert" aria-live="assertive">${this.submitError}</div>`
        : nothing}
      ${this.awaiting
        ? html`<div
            class="awaiting-banner ${this.awaitingStalled ? 'is-stalled' : ''}"
            role="status"
            aria-live="polite"
          >
            ${this.awaitingStalled
              ? html`<span class="material-symbols" aria-hidden="true">info</span>`
              : html`<div class="small-spinner"></div>`}
            <span>${this.awaitingMessage}</span>
          </div>`
        : nothing}
      <div class="a2ui-host" aria-disabled=${this.awaiting ? 'true' : 'false'}>
        ${repeat(
          surfaces,
          ([id]) => id,
          ([, surface]) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
        )}
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
    </section>`;
  }

  private renderHtml() {
    if (this.htmlBody == null) {
      return html`<div class="pending">
        <div class="spinner"></div>
        <div class="status">Loading…</div>
      </div>`;
    }
    // No chrome wrapper — the iframe itself is the page. Defense-in-depth
    // (sandbox + meta-CSP + server-side sanitize) still applies; the
    // chrome bar was only a visual disclosure and the product call is to
    // render HTML pages exactly as if the user opened the .html file.
    return this.htmlIframe();
  }

  // The Lit literal cannot embed a raw iframe element easily because Lit owns
  // attribute setting and srcdoc would be re-escaped. We construct the iframe
  // imperatively and stash it across renders via this helper.
  private cachedIframe: HTMLIFrameElement | null = null;
  private cachedIframeFor: string | null = null;
  private htmlIframe() {
    if (this.htmlBody == null) return nothing;
    if (this.cachedIframe == null || this.cachedIframeFor !== this.htmlBody) {
      this.cachedIframe = createSandboxedIframe(this.htmlBody);
      this.cachedIframeFor = this.htmlBody;
    }
    return this.cachedIframe;
  }
}

customElements.define('agent-ui-app', AgentUIApp);

const root = document.getElementById('app')!;
if (location.pathname === '/_components') {
  root.classList.add('is-home');
  root.appendChild(document.createElement('components-showcase'));
} else if (!pageId) {
  root.classList.add('is-home');
  root.appendChild(document.createElement('home-page'));
} else {
  root.appendChild(document.createElement('agent-ui-app'));
}
