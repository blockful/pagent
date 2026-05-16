import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, css } from 'lit';
import * as v0_9 from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import { buildShowcaseSpec } from './showcase-spec.js';

class ComponentsShowcase extends SignalWatcher(LitElement) {
  static styles = css`
    :host {
      display: block;
      max-width: 640px;
      margin: 0 auto;
      padding: 2rem 1rem 4rem;
    }
  `;

  private processor = new v0_9.MessageProcessor([basicCatalog], () => {});

  connectedCallback() {
    super.connectedCallback();
    this.processor.processMessages(buildShowcaseSpec());
  }

  render() {
    const surfaces = Array.from(this.processor.model.surfacesMap.entries());
    if (surfaces.length === 0) return html`<p>No surfaces</p>`;
    return html`${surfaces.map(
      ([, surface]) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
    )}`;
  }
}

customElements.define('components-showcase', ComponentsShowcase);
