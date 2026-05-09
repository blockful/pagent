import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, css, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import * as v0_9 from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9'; // registers <a2ui-surface>

type ServerEvent =
  | { id: number; type: 'surface_updated'; format: string; spec: unknown; ts: number }
  | { id: number; type: 'user_action'; action: unknown; ts: number }
  | { id: number; type: 'session_closed'; ts: number };

const sessionId = location.pathname.replace(/^\/+/, '').split('/')[0];

class AgentUIApp extends SignalWatcher(LitElement) {
  static properties = {
    status: { state: true },
    error: { state: true },
    surfaceTick: { state: true },
  };

  static styles = css`
    :host { display: block; }
    .status { color: var(--muted, #777); text-align: center; padding: 24px; font-size: 14px; }
    .pending { display: flex; flex-direction: column; gap: 16px; align-items: center; padding: 64px 16px; }
    .spinner { width: 40px; height: 40px; border: 4px solid rgba(127,127,127,0.2); border-left-color: var(--primary, #5154b3); border-radius: 50%; animation: spin 1s linear infinite; }
    .error { background: var(--error-bg, #ffedea); color: var(--error, #ba1a1a); padding: 16px; border-radius: 8px; margin: 16px 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #surfaces { padding: var(--bb-grid-size-3, 12px); animation: fadeIn .35s cubic-bezier(0,0,.3,1); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  `;

  declare status: 'connecting' | 'live' | 'closed' | 'error';
  declare error: string | null;
  declare surfaceTick: number;

  constructor() {
    super();
    this.status = 'connecting';
    this.error = null;
    this.surfaceTick = 0;
  }

  private processor = new v0_9.MessageProcessor(
    [basicCatalog],
    async (action: v0_9.A2uiClientAction) => {
      try {
        const res = await fetch(`/sessions/${sessionId}/actions`, {
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
        if (!res.ok) console.warn('action POST failed', res.status);
      } catch (err) {
        console.error('action POST error', err);
      }
    },
  );

  private es: EventSource | null = null;

  connectedCallback() {
    super.connectedCallback();
    if (!sessionId) {
      this.status = 'error';
      this.error = 'No session id in URL.';
      return;
    }
    this.connect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.es?.close();
  }

  private connect() {
    const url = `/sessions/${sessionId}/events?since=0`;
    const es = new EventSource(url);
    this.es = es;
    es.onopen = () => { this.status = 'live'; };
    es.onmessage = (e) => this.handleEvent(JSON.parse(e.data) as ServerEvent);
    es.onerror = () => {
      if (this.status !== 'closed') this.status = 'error';
    };
  }

  private handleEvent(ev: ServerEvent) {
    if (ev.type === 'surface_updated') {
      for (const id of Array.from(this.processor.model.surfacesMap.keys())) {
        this.processor.model.deleteSurface(id);
      }
      try {
        this.processor.processMessages(ev.spec as any);
        this.error = null;
      } catch (err) {
        console.error('processMessages failed', err, ev);
        this.error = String(err);
      }
      this.surfaceTick++;
    } else if (ev.type === 'session_closed') {
      this.status = 'closed';
      this.es?.close();
    }
    // user_action is our own echo — ignore.
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
      return html`<div class="pending"><div class="spinner"></div><div class="status">Waiting for the agent…</div></div>`;
    }
    void this.surfaceTick;
    return html`<section id="surfaces">
      ${repeat(
        surfaces,
        ([id]) => id,
        ([, surface]) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
      )}
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
    </section>`;
  }
}

customElements.define('agent-ui-app', AgentUIApp);
document.getElementById('app')!.appendChild(document.createElement('agent-ui-app'));
