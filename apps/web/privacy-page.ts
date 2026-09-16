import { LitElement, html } from 'lit';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

class PrivacyPage extends LitElement {
  static styles = [productStyles, productLayoutStyles];

  render() {
    return html`<a class="skip-link" href="#main">Skip to privacy notice</a>
      <div class="shell product-shell">
        <header class="topbar">
          <a class="brand" href="/"><span class="brand-mark"></span>Pagent</a
          ><a class="button quiet" href="/pages">Pages</a>
        </header>
        <product-navigation current="privacy"></product-navigation>
        <main class="page prose" id="main">
          <header class="page-head">
            <div>
              <p class="eyebrow">Viewer privacy</p>
              <h1>Engagement analytics, plainly explained.</h1>
              <p class="lede">
                Pagent measures presentation engagement for the sender while limiting collection to
                what is needed for that purpose.
              </p>
            </div>
          </header>
          <section class="surface stack">
            <h2>What is recorded</h2>
            <p>
              After a presentation page is at least half visible and you interact, Pagent may record
              the visit time, share link, presentation revision, viewed slides, active time,
              completion, device class, browser family, and coarse country. Background tabs and
              periods without activity for 60 seconds do not add active time.
            </p>
            <p>
              Identity is shown as <strong>Anonymous</strong>, <strong>Unverified</strong>, or
              <strong>Authenticated</strong>. An address entered at an Allowed email gate is not
              inbox-verified and is always labeled Unverified.
            </p>
          </section>
          <section class="surface stack">
            <h2>Controls and retention</h2>
            <p>
              Workspace administrators configure analytics consent and retention. If consent is
              required, tracking stays disabled until you opt in. Owners can restrict who sees
              analytics, export records, and delete a page; access and export changes are audited.
            </p>
            <p>
              Automated traffic and owner previews are excluded. Share tokens are stored as hashes,
              and raw tokens or viewer email addresses are not placed in analytics URLs.
            </p>
          </section>
        </main>
      </div>`;
  }
}

customElements.define('privacy-page', PrivacyPage);
