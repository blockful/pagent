import { LitElement } from 'lit';
import { AGENT_PROMPT, renderHomeContent } from './home-content.js';
import { homeStyles } from './home-styles.js';

class HomePage extends LitElement {
  static properties = {
    copied: { state: true },
  };

  static styles = homeStyles;

  declare copied: boolean;

  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.copied = false;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this._onHashChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._copyTimer) clearTimeout(this._copyTimer);
    window.removeEventListener('hashchange', this._onHashChange);
  }

  firstUpdated() {
    // The browser's own fragment pass can't see into the shadow root, and its
    // late not-found fallback (plus webfont layout shifts) can stomp a single
    // early programmatic scroll. Re-assert a few times across the load window;
    // _scrollToHash no-ops unless the hash is #install.
    let tries = 0;
    const tick = () => {
      this._scrollToHash();
      if (++tries < 4) setTimeout(tick, 300);
    };
    tick();
  }

  private _onHashChange = () => this._scrollToHash();

  // The #install target lives inside this shadow root, where native URL
  // fragment navigation can't see it — scroll explicitly instead. Instant
  // (not smooth): smooth scrollIntoView silently no-ops in some Chromium
  // environments, and landing on the install panel is a conversion path.
  private _scrollToHash() {
    if (location.hash !== '#install') return;
    this.shadowRoot?.getElementById('install')?.scrollIntoView({ block: 'start' });
  }

  private async _onCopy() {
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
    } catch {
      // clipboard may be unavailable (insecure context); still flash UX
    }
    this.copied = true;
    if (this._copyTimer) clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      this.copied = false;
    }, 1800);
  }

  render() {
    return renderHomeContent(this.copied, () => this._onCopy());
  }
}

customElements.define('home-page', HomePage);
