import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import * as v0_9 from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9'; // registers <a2ui-surface>

type PageState = 'open' | 'submitted' | 'received';
type PageResponse = {
  spec: unknown;
  state: PageState;
  result: unknown | null;
  expires_at: number | string;
};

const pageId = location.pathname.replace(/^\/+/, '').split('/')[0];

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

class AgentUIApp extends SignalWatcher(LitElement) {
  static properties = {
    status: { state: true },
    error: { state: true },
    awaiting: { state: true },
    awaitingMessage: { state: true },
  };

  static styles = css`
    :host { display: block; }
    .status { color: var(--muted, #777); text-align: center; padding: 24px; font-size: 14px; }
    .pending { display: flex; flex-direction: column; gap: 16px; align-items: center; padding: 64px 16px; }
    .spinner { width: 40px; height: 40px; border: 4px solid rgba(127,127,127,0.2); border-left-color: var(--primary, #5154b3); border-radius: 50%; animation: spin 1s linear infinite; }
    .small-spinner { width: 16px; height: 16px; border: 2px solid rgba(127,127,127,0.25); border-left-color: var(--primary, #5154b3); border-radius: 50%; animation: spin .9s linear infinite; }
    .error { background: var(--error-bg, #ffedea); color: var(--error, #ba1a1a); padding: 16px; border-radius: 8px; margin: 16px 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #surfaces { padding: var(--bb-grid-size-3, 12px); animation: fadeIn .35s cubic-bezier(0,0,.3,1); position: relative; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

    .surface-wrap { position: relative; }
    .surface-wrap.is-awaiting .a2ui-host { opacity: .45; pointer-events: none; filter: saturate(.6); transition: opacity .2s, filter .2s; }
    .a2ui-host { transition: opacity .2s, filter .2s; }
    .awaiting-banner {
      position: sticky; top: 12px; z-index: 2;
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; margin-bottom: 12px;
      border-radius: 999px;
      background: light-dark(rgba(255,255,255,0.85), rgba(20,28,40,0.85));
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 18px rgba(0,0,0,0.08);
      color: var(--fg, #1b1b1b);
      font-size: 14px;
      width: fit-content; margin-left: auto; margin-right: auto;
      animation: fadeIn .25s ease-out;
    }
  `;

  declare status: 'connecting' | 'live' | 'closed' | 'error';
  declare error: string | null;
  declare awaiting: boolean;
  declare awaitingMessage: string;

  constructor() {
    super();
    this.status = 'connecting';
    this.error = null;
    this.awaiting = false;
    this.awaitingMessage = 'Sent — waiting for the agent…';
  }

  private processor = new v0_9.MessageProcessor(
    [basicCatalog],
    async (action: v0_9.A2uiClientAction) => {
      if (this.awaiting) return; // already submitted — drop duplicate
      // Optimistic lock — the page is single-shot, so prevent further submits
      // and surface the "waiting for the agent" banner immediately.
      this.awaiting = true;
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
          this.awaiting = false;
          return;
        }
        this.startPollingForReceived();
      } catch (err) {
        console.error('result POST error', err);
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
      this.processor.processMessages(spec as any);
      this.error = null;
    } catch (err) {
      console.error('processMessages failed', err, spec);
      this.error = String(err);
    }
  }

  private startPollingForReceived() {
    this.stopPolling();
    this.pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      if (Date.now() >= this.pollDeadline) return;
      try {
        const res = await fetch(`${API_BASE}/${pageId}`, {
          headers: { accept: 'application/json' },
        });
        if (res.ok) {
          const page = (await res.json()) as PageResponse;
          if (page.state === 'received') {
            this.awaitingMessage = '✓ The agent has your input';
            return; // stop polling
          }
        }
        // otherwise keep polling (including 404, since the page may have been
        // evicted; we just stop on timeout/disconnect rather than spam errors).
      } catch (err) {
        console.warn('poll GET failed', err);
      }
      if (!this.isConnected) return;
      if (Date.now() >= this.pollDeadline) return;
      this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
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
    const surfaces = Array.from(this.processor.model.surfacesMap.entries());
    if (surfaces.length === 0) {
      return html`<div class="pending"><div class="spinner"></div><div class="status">Loading…</div></div>`;
    }
    return html`<section id="surfaces" class="surface-wrap ${this.awaiting ? 'is-awaiting' : ''}">
      ${this.awaiting
        ? html`<div class="awaiting-banner" role="status" aria-live="polite">
            <div class="small-spinner"></div>
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
}

customElements.define('agent-ui-app', AgentUIApp);
document.getElementById('app')!.appendChild(document.createElement('agent-ui-app'));
