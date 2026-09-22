import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { z } from 'zod';
import { API_BASE } from './deck-api.ts';
import { productStyles } from './product-styles.ts';

const frameMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pagent:error') }).strict(),
  z.object({ type: z.literal('pagent:activity') }).strict(),
]);

export class DocumentFrame extends LitElement {
  static properties = {
    sessionToken: { attribute: false },
    deckId: { attribute: false },
    revisionId: { attribute: false },
    documentTitle: { type: String },
    state: { state: true },
  };

  static styles = [
    productStyles,
    css`
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 0;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
      }
      .frame-status {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        padding: var(--pg-space-4);
        background: var(--pg-canvas);
        color: var(--pg-ink);
        text-align: center;
      }
    `,
  ];

  declare sessionToken: string;
  declare deckId: string;
  declare revisionId: string;
  declare documentTitle: string;
  declare state: 'loading' | 'ready' | 'error';
  private readonly frameName = `document-${crypto.randomUUID()}`;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private frameInitialized = false;
  private responseFailed = false;

  constructor() {
    super();
    this.sessionToken = '';
    this.deckId = '';
    this.revisionId = '';
    this.documentTitle = 'Shared HTML page';
    this.state = 'loading';
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.onMessage);
  }

  disconnectedCallback(): void {
    window.removeEventListener('message', this.onMessage);
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('sessionToken') || changed.has('deckId') || changed.has('revisionId'))
      this.submit();
  }

  private submit(): void {
    if (!this.frameInitialized) return;
    if (this.revisionId === '' || (this.sessionToken === '' && this.deckId === '')) return;
    const form = this.renderRoot.querySelector('form');
    if (!(form instanceof HTMLFormElement)) return;
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    this.state = 'loading';
    this.responseFailed = false;
    this.loadTimer = setTimeout(() => {
      this.state = 'error';
    }, 15_000);
    form.submit();
  }

  private onLoad = (): void => {
    if (!this.frameInitialized) {
      this.frameInitialized = true;
      this.submit();
      return;
    }
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    if (!this.responseFailed) this.state = 'ready';
  };

  private onMessage = (event: MessageEvent<unknown>): void => {
    const iframe = this.renderRoot.querySelector('iframe');
    if (event.origin !== 'null' || event.source !== iframe?.contentWindow) return;
    const parsed = frameMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    switch (parsed.data.type) {
      case 'pagent:error':
        if (this.loadTimer !== null) clearTimeout(this.loadTimer);
        this.responseFailed = true;
        this.state = 'error';
        break;
      case 'pagent:activity':
        if (this.state === 'ready')
          this.dispatchEvent(
            new CustomEvent('document-activity', { bubbles: true, composed: true }),
          );
        break;
    }
  };

  render() {
    const viewer = this.sessionToken !== '';
    return html`
      <iframe
        name=${this.frameName}
        title=${this.documentTitle}
        @load=${this.onLoad}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        allow="fullscreen *"
      ></iframe>
      <form
        hidden
        method="post"
        action=${`${API_BASE}/v1/${viewer ? 'viewer' : 'owner'}/document`}
        target=${this.frameName}
      >
        <input type="hidden" name="revision_id" .value=${this.revisionId} />
        ${viewer
          ? html`<input type="hidden" name="session_token" .value=${this.sessionToken} />`
          : html`<input type="hidden" name="deck_id" .value=${this.deckId} />`}
      </form>
      ${this.state === 'ready'
        ? nothing
        : html`<div class="frame-status">
            ${this.state === 'loading'
              ? html`<p role="status">Opening page…</p>`
              : html`<div role="alert">
                  <p>The page could not be opened. Refresh if access or content has changed.</p>
                  <button class="button secondary" @click=${() => this.submit()}>Retry</button>
                </div>`}
          </div>`}
    `;
  }
}

customElements.define('document-frame', DocumentFrame);
