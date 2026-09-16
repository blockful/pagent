/**
 * Always-on, zero-install demo at /demo. Renders both Pagent tools side by side
 * with no backend page: a live `show_ui` A2UI form (the result is shown inline
 * instead of POSTed to an agent) and a sandboxed `show_html` dashboard.
 *
 * Reuses the same building blocks as the real renderer:
 *  - v0_9.MessageProcessor + basicCatalog + <a2ui-surface> (see components-showcase.ts / main.ts)
 *  - createSandboxedIframe (see html-renderer.ts)
 * so the demo shows the genuine article, not a mockup.
 */
import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, css, nothing } from 'lit';
import * as v0_9 from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9'; // registers <a2ui-surface>
import { createSandboxedIframe } from './html-renderer.ts';

/**
 * A small but real A2UI surface — the kind of thing an agent emits via
 * show_ui. Built as a typed function (same shape as showcase-spec.ts) so tsc
 * checks the literal against the A2UI message types — no `as unknown as`.
 */
function buildDemoFormSpec() {
  const components = [
    {
      id: 'root',
      component: 'Column',
      children: ['title', 'sub', 'name', 'project', 'subscribe', 'submit'],
    },
    { id: 'title', component: 'Text', text: 'Tell the agent about you' },
    { id: 'sub', component: 'Text', text: 'A real form — fill it in and submit.' },
    { id: 'name', component: 'TextField', label: 'Your name', value: { path: '/name' } },
    {
      id: 'project',
      component: 'TextField',
      label: 'What are you building?',
      value: { path: '/project' },
    },
    {
      id: 'subscribe',
      component: 'CheckBox',
      label: 'Send me Pagent launch updates',
      value: { path: '/subscribe' },
    },
    { id: 'submit-label', component: 'Text', text: 'Submit' },
    {
      id: 'submit',
      component: 'Button',
      child: 'submit-label',
      variant: 'primary',
      action: {
        event: {
          name: 'submitted',
          context: {
            name: { path: '/name' },
            project: { path: '/project' },
            subscribe: { path: '/subscribe' },
          },
        },
      },
    },
  ];

  const V = 'v0.9' as const;
  return [
    { version: V, createSurface: { surfaceId: 'demo', catalogId: basicCatalog.id } },
    { version: V, updateComponents: { surfaceId: 'demo', components } },
  ];
}

/** A small static dashboard — the kind of thing an agent emits via show_html. */
const DEMO_DASHBOARD_HTML = `<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 20px; color: #1b1b1b; background: #fff; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #777; font-size: 12px; margin: 0 0 16px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
  .stat { flex: 1; min-width: 110px; padding: 14px; background: #f5f5f7; border-radius: 10px; }
  .stat .v { font-size: 26px; font-weight: 700; line-height: 1; }
  .stat .l { font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: .04em; margin-top: 6px; }
  .bars { display: flex; align-items: flex-end; gap: 8px; height: 96px; }
  .bar { flex: 1; background: linear-gradient(#5154b3, #a0a3ff); border-radius: 4px 4px 0 0; }
  .h1 { height: 58% } .h2 { height: 80% } .h3 { height: 44% }
  .h4 { height: 96% } .h5 { height: 70% } .h6 { height: 88% }
</style>
<h1>Test results — last run</h1>
<p class="sub">Rendered by your agent with show_html</p>
<div class="row">
  <div class="stat"><div class="v">142</div><div class="l">passed</div></div>
  <div class="stat"><div class="v">3</div><div class="l">failed</div></div>
  <div class="stat"><div class="v">96%</div><div class="l">coverage</div></div>
</div>
<div class="bars">
  <div class="bar h1"></div><div class="bar h2"></div><div class="bar h3"></div>
  <div class="bar h4"></div><div class="bar h5"></div><div class="bar h6"></div>
</div>`;

class PagentDemo extends SignalWatcher(LitElement) {
  static properties = {
    submitted: { state: true },
  };

  declare submitted: Record<string, unknown> | null;

  static styles = css`
    :host {
      display: block;
      max-width: 1040px;
      margin: 0 auto;
      padding: clamp(20px, 4vw, 40px) clamp(16px, 4vw, 32px) 64px;
      color: var(--fg, #1b1b1b);
    }
    .demo-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .demo-title {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0 0 24px;
    }
    .back {
      font-weight: 600;
      text-decoration: none;
      color: var(--fg, #1b1b1b);
    }
    .tag {
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted, #777);
      border: 1px solid var(--a2ui-color-border, #e4e4e7);
      border-radius: 999px;
      padding: 4px 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 820px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .panel {
      border: 1px solid var(--a2ui-color-border, #e4e4e7);
      border-radius: 14px;
      padding: 20px;
      background: var(--a2ui-color-surface, #fff);
    }
    .panel h2 {
      font-size: 15px;
      margin: 0 0 4px;
    }
    .panel h2 .k {
      font-family: ui-monospace, 'JetBrains Mono', monospace;
      color: var(--primary, #5154b3);
    }
    .hint {
      font-size: 13px;
      color: var(--muted, #777);
      margin: 0 0 16px;
    }
    .result {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 10px;
      background: light-dark(#eef6ec, #15241a);
      color: light-dark(#1d5b2a, #9bc78a);
      font-family: ui-monospace, 'JetBrains Mono', monospace;
      font-size: 12.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .dash {
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid var(--a2ui-color-border, #e4e4e7);
    }
    .demo-foot {
      margin-top: 28px;
      text-align: center;
      font-size: 14px;
      color: var(--muted, #777);
    }
    .demo-foot a {
      color: var(--primary, #5154b3);
      font-weight: 600;
    }
  `;

  private processor = new v0_9.MessageProcessor([basicCatalog], (action: v0_9.A2uiClientAction) => {
    // No backend: surface the result inline so the user sees what the agent
    // would have received.
    this.submitted = (action.context ?? {}) as Record<string, unknown>;
  });

  constructor() {
    super();
    this.submitted = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Idempotent across detach/re-attach: replaying createSurface for an
    // existing surfaceId throws A2uiStateError inside the lifecycle callback.
    if (this.processor.model.surfacesMap.size > 0) return;
    this.processor.processMessages(buildDemoFormSpec());
  }

  // One static iframe for the page's lifetime (Lit can't bind srcdoc cleanly,
  // and the demo HTML is a constant). Only the height deviates from the
  // lockdown defaults createSandboxedIframe sets.
  private readonly dashboardFrame = (() => {
    const frame = createSandboxedIframe(DEMO_DASHBOARD_HTML);
    frame.style.height = '300px';
    return frame;
  })();

  render() {
    const surfaces = Array.from(this.processor.model.surfacesMap.entries());
    return html`
      <header class="demo-head">
        <a class="back" href="/">← Pagent</a>
        <span class="tag">Live demo · no install</span>
      </header>
      <h1 class="demo-title">See what your agent can show you</h1>
      <div class="grid">
        <section class="panel">
          <h2><span class="k">show_ui</span> — ask, read the answer back</h2>
          <p class="hint">
            A real Pagent form. Fill it in and submit — in a live session your agent receives the
            result and continues.
          </p>
          ${surfaces.map(([, s]) => html`<a2ui-surface .surface=${s}></a2ui-surface>`)}
          ${this.submitted
            ? html`<pre class="result">
✓ Your agent would receive:
${JSON.stringify(this.submitted, null, 2)}</pre
              >`
            : nothing}
        </section>
        <section class="panel">
          <h2><span class="k">show_html</span> — show a dashboard, view-only</h2>
          <p class="hint">
            Agents can also render rich, sandboxed visualizations you just look at — no JavaScript,
            fully isolated.
          </p>
          <div class="dash">${this.dashboardFrame}</div>
        </section>
      </div>
      <footer class="demo-foot">
        Want this in your agent? <a href="/#install">Install Pagent</a> — works in any MCP client,
        free, no signup.
      </footer>
    `;
  }
}

customElements.define('pagent-demo', PagentDemo);
