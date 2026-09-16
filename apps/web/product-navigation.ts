import { LitElement, css, html, nothing } from 'lit';

class ProductNavigation extends LitElement {
  static properties = { current: { type: String } };
  static styles = css`
    :host {
      display: block;
      padding: var(--pg-space-2) var(--pg-space-5);
      overflow-x: auto;
      border-bottom: 1px solid var(--pg-rule);
      background: var(--pg-surface);
    }
    nav {
      display: flex;
      align-items: center;
      gap: var(--pg-space-2);
    }
    .label {
      color: var(--pg-ink-secondary);
      font: 600 var(--pg-type-xs) / 1.35 var(--pg-font-metadata);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    a {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      padding: var(--pg-space-2) var(--pg-space-3);
      border-radius: 8px;
      color: var(--pg-ink-secondary);
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
    }
    a:hover,
    a[aria-current='page'] {
      color: var(--pg-surface);
      background: var(--pg-ink);
    }
    a:focus-visible {
      outline: 2px solid var(--pg-focus);
      outline-offset: 2px;
    }
    @media (min-width: 901px) {
      :host {
        position: sticky;
        top: 64px;
        align-self: start;
        height: calc(100vh - 64px);
        padding: var(--pg-space-8) var(--pg-space-5);
        overflow: auto;
        border-right: 1px solid var(--pg-rule);
        border-bottom: 0;
      }
      nav {
        align-items: stretch;
        flex-direction: column;
      }
      .label {
        margin: 0 0 var(--pg-space-2) var(--pg-space-3);
      }
    }
    @media (max-width: 640px) {
      .label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
    }
    @media (min-width: 1200px) {
      :host {
        padding-inline: var(--pg-space-8);
      }
    }
  `;

  declare current: 'decks' | 'privacy' | '';

  constructor() {
    super();
    this.current = '';
  }

  render() {
    return html`<nav aria-label="Product">
      <span class="label">Workspace</span>
      ${this.link('/decks', 'Decks', 'decks')}${this.link(
        '/privacy',
        'Privacy',
        'privacy',
      )}${this.link('/', 'Publish guide', '')}
    </nav>`;
  }

  private link(href: string, label: string, section: ProductNavigation['current']) {
    return html`<a href=${href} aria-current=${this.current === section ? 'page' : nothing}
      >${label}</a
    >`;
  }
}

customElements.define('product-navigation', ProductNavigation);
