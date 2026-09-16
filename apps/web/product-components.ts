import { LitElement, html, nothing } from 'lit';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

class ProductComponents extends LitElement {
  static styles = [productStyles, productLayoutStyles];

  render() {
    return html`
      <div class="shell">
        <header class="topbar">
          <a class="brand" href="/"><span class="brand-mark"></span>Pagent</a>
          <span class="badge active">Primitive showcase</span>
        </header>
        <main class="page stack" id="main">
          <header class="page-head">
            <div>
              <p class="eyebrow">Design system · product surfaces</p>
              <h1 class="display-title">Trustworthy by construction.</h1>
              <p class="lede">The exact controls, states, and responsive records used by Decks.</p>
            </div>
          </header>
          <section class="surface stack" aria-labelledby="actions-title">
            <h2 id="actions-title">Actions and identity</h2>
            <div class="cluster">
              <button class="button">Primary action</button>
              <button class="button secondary">Secondary</button>
              <button class="button quiet">Quiet action</button>
              <button class="button destructive">Revoke link</button>
              <button class="button" aria-busy="true" disabled>Publishing…</button>
            </div>
            <div class="cluster">
              <span class="badge">Anonymous</span>
              <span class="badge unverified">Unverified</span>
              <span class="badge authenticated">Authenticated</span>
              <span class="badge expired">Expired</span>
              <span class="badge revoked">Revoked</span>
            </div>
          </section>
          <section class="detail-grid">
            <div class="surface stack">
              <h2>Fields and access choice</h2>
              <div class="field">
                <label for="showcase-name">Link name</label>
                <input id="showcase-name" value="Northstar review" />
                <small>Visible only to your workspace.</small>
              </div>
              <label class="choice">
                <input type="radio" name="showcase-access" checked />
                <span
                  ><strong>Allowed email</strong><br /><small
                    >Self-declared and labeled Unverified.</small
                  ></span
                >
              </label>
              <label class="choice">
                <input type="radio" name="showcase-access" />
                <span
                  ><strong>Authenticated viewer</strong><br /><small
                    >Proves control of an allowed address.</small
                  ></span
                >
              </label>
            </div>
            <div class="stack">
              <aside class="notice warning">
                <strong>Identity note.</strong> Email-only access does not verify inbox ownership.
              </aside>
              <aside class="notice error">
                <strong>Revoked.</strong> This link no longer returns deck content.
              </aside>
              <div class="surface stack" aria-busy="true">
                <span class="loading-line"></span>
                <span class="loading-line" style="width:72%"></span>
                ${nothing}
              </div>
            </div>
          </section>
          <section class="surface stack">
            <h2>Tabs and responsive records</h2>
            <div class="tabs" role="tablist" aria-label="Deck detail views">
              <button class="tab" role="tab" aria-selected="true">Overview</button>
              <button class="tab" role="tab" aria-selected="false">Visitors</button>
              <button class="tab" role="tab" aria-selected="false">Slides</button>
              <button class="tab" role="tab" aria-selected="false">Share links</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Deck</th>
                    <th>Owner</th>
                    <th>Access</th>
                    <th>Viewers</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td data-label="Deck">
                      <a class="primary-link" href="/decks">Northstar renewal</a>
                    </td>
                    <td data-label="Owner">ana@example.com</td>
                    <td data-label="Access"><span class="badge unverified">Allowed email</span></td>
                    <td data-label="Viewers" class="mono">24</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    `;
  }
}

customElements.define('product-components', ProductComponents);
