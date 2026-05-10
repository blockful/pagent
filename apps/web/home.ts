import { LitElement, html, css } from 'lit';

class HomePage extends LitElement {
  static styles = css`
    :host {
      display: block;
      --ink: #15140f;
      --paper: #f4ede1;
      --paper-2: #ebe2d2;
      --accent: #c8472f;
      --accent-soft: rgba(200, 71, 47, 0.12);
      --muted: #6e685c;
      --rule: #d8cdb9;
    }

    .page {
      min-height: 100vh;
      background:
        radial-gradient(ellipse at 12% -10%, rgba(200, 71, 47, 0.08), transparent 55%),
        radial-gradient(ellipse at 100% 110%, rgba(21, 20, 15, 0.05), transparent 55%),
        var(--paper);
      color: var(--ink);
      padding: clamp(28px, 5vw, 64px) clamp(20px, 5vw, 56px);
      position: relative;
      overflow: hidden;
    }

    .page::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.08  0 0 0 0 0.08  0 0 0 0 0.06  0 0 0 0.35 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
      opacity: 0.35;
      pointer-events: none;
      mix-blend-mode: multiply;
    }

    .container {
      position: relative;
      max-width: 1040px;
      margin: 0 auto;
    }

    .nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12px;
      letter-spacing: 0.08em;
      color: var(--muted);
      padding-bottom: 20px;
      border-bottom: 1px solid var(--rule);
      text-transform: uppercase;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-weight: 500;
    }

    .dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft);
      animation: pulse 2.4s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 4px var(--accent-soft); }
      50%      { box-shadow: 0 0 0 7px rgba(200, 71, 47, 0.06); }
    }

    .hero {
      padding: clamp(56px, 10vw, 128px) 0 clamp(48px, 8vw, 96px);
      max-width: 920px;
      animation: rise .9s cubic-bezier(.2,.7,.2,1) both;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: none; }
    }

    .eyebrow {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      color: var(--accent);
      margin: 0 0 28px;
      display: inline-flex;
      align-items: center;
      gap: 12px;
    }

    .eyebrow::before {
      content: '';
      width: 28px;
      height: 1px;
      background: var(--accent);
    }

    h1 {
      font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
      font-weight: 400;
      font-size: clamp(44px, 7.5vw, 104px);
      line-height: 0.96;
      letter-spacing: -0.018em;
      margin: 0 0 36px;
    }

    h1 em {
      font-style: italic;
      color: var(--accent);
      position: relative;
    }

    h1 em::after {
      content: '';
      position: absolute;
      left: 0; right: 0; bottom: 0.08em;
      height: 0.08em;
      background: var(--accent);
      opacity: 0.18;
      transform: skewX(-12deg);
    }

    .lede {
      max-width: 620px;
      font-size: clamp(17px, 1.4vw, 19px);
      line-height: 1.55;
      color: #3a352d;
      margin: 0;
    }

    .lede strong { color: var(--ink); font-weight: 500; }

    .terminal {
      margin-top: 44px;
      max-width: 560px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 13.5px;
      background: #15140f;
      color: #ebe2d2;
      border-radius: 10px;
      padding: 18px 20px;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.06) inset,
        0 30px 60px -30px rgba(21, 20, 15, 0.4),
        0 12px 30px -12px rgba(21, 20, 15, 0.25);
      line-height: 1.7;
    }

    .terminal .prompt { color: var(--accent); user-select: none; margin-right: 10px; }
    .terminal .dim    { color: #8c8478; }
    .terminal .url    { color: #f6c89f; text-decoration: underline; text-decoration-color: rgba(246, 200, 159, 0.4); }
    .caret {
      display: inline-block;
      width: 8px; height: 1em;
      background: #ebe2d2;
      vertical-align: -2px;
      margin-left: 4px;
      animation: blink 1.05s steps(2, jump-none) infinite;
    }

    @keyframes blink { 50% { opacity: 0; } }

    .section-label {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 28px;
    }

    .section-label::before {
      content: '— ';
      margin-right: 8px;
      color: var(--accent);
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0;
      border-top: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
    }

    @media (max-width: 760px) {
      .steps { grid-template-columns: 1fr; }
      .step + .step { border-top: 1px solid var(--rule); border-left: 0; }
    }

    .step {
      padding: 36px 28px 40px;
      position: relative;
      transition: background .25s ease;
    }
    .step + .step { border-left: 1px solid var(--rule); }
    .step:hover { background: rgba(255,255,255,0.35); }

    .step-num {
      font-family: 'Instrument Serif', Georgia, serif;
      font-style: italic;
      font-weight: 400;
      font-size: 56px;
      color: var(--accent);
      line-height: 1;
      margin-bottom: 14px;
      letter-spacing: -0.02em;
    }

    .step h3 {
      font-family: 'Outfit', system-ui, sans-serif;
      font-size: 17px;
      font-weight: 500;
      letter-spacing: -0.005em;
      margin: 0 0 10px;
    }

    .step p {
      font-size: 14.5px;
      line-height: 1.55;
      color: var(--muted);
      margin: 0;
    }

    .step code {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12.5px;
      background: rgba(21, 20, 15, 0.06);
      color: var(--ink);
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid rgba(21, 20, 15, 0.05);
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      padding-top: 28px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11.5px;
      color: var(--muted);
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .footer a {
      color: var(--ink);
      text-decoration: none;
      border-bottom: 1px solid currentColor;
      padding-bottom: 1px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: color .2s ease;
    }
    .footer a:hover { color: var(--accent); }
    .footer .arrow { transition: transform .2s ease; display: inline-block; }
    .footer a:hover .arrow { transform: translate(2px, -2px); }
  `;

  render() {
    return html`
      <div class="page">
        <div class="container">
          <nav class="nav">
            <span class="badge"><span class="dot"></span>Agent UI Session</span>
            <span>v0.9 &nbsp;/&nbsp; A2UI</span>
          </nav>

          <header class="hero">
            <p class="eyebrow">Generative UI · for terminal agents</p>
            <h1>Give your agent a <em>real UI</em>—<br />not a fake form in prose.</h1>
            <p class="lede">
              Your terminal agent posts a form spec, gets back a short URL, and waits.
              You open it, fill it out, submit. The agent reads the result and keeps going.
              <strong>One handoff. Single-shot. No host app required.</strong>
            </p>

            <div class="terminal" aria-hidden="true">
              <div><span class="prompt">$</span><span class="dim">agent ›</span> show_ui(spec)</div>
              <div><span class="prompt">↳</span><span class="url">https://agent-ui.app/4f2a…b13c</span></div>
              <div><span class="prompt">$</span><span class="dim">agent ›</span> wait_for_result<span class="caret"></span></div>
            </div>
          </header>

          <p class="section-label"><span>How it works</span><span>three steps</span></p>

          <section class="steps">
            <article class="step">
              <div class="step-num">i.</div>
              <h3>Wire the MCP server</h3>
              <p>Add one config line pointing at the hosted endpoint. Drop the bundled <code>SKILL.md</code> into your project so the agent knows when to reach for a form.</p>
            </article>
            <article class="step">
              <div class="step-num">ii.</div>
              <h3>Agent calls show_ui</h3>
              <p>When structured input is needed, the agent calls <code>show_ui(spec)</code> and prints the returned URL to your terminal.</p>
            </article>
            <article class="step">
              <div class="step-num">iii.</div>
              <h3>Click. Fill. Submit.</h3>
              <p>You complete the form in the browser. The agent's <code>wait_for_result</code> returns the action and the conversation continues.</p>
            </article>
          </section>

          <div class="footer">
            <span>Hono · Vite · A2UI · Supabase</span>
            <a href="https://github.com/blockful/agent-ui-session" target="_blank" rel="noopener noreferrer">
              View on GitHub <span class="arrow">↗</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('home-page', HomePage);
