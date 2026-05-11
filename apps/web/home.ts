import { LitElement, html, css } from 'lit';

type InstallKind = 'prompt' | 'plugin' | 'http';

const AGENT_PROMPT = `Add the pagent MCP server to your tools so you can render real UI forms for me instead of asking in chat.

MCP server (streamable HTTP):
  https://pagent.up.railway.app/mcp

Skill (when and how to use it — read this):
  https://raw.githubusercontent.com/blockful/pagent/main/skills/pagent/SKILL.md

Install the MCP however your client expects, read the skill, then confirm by listing the show_ui and check_result tools.`;

const INSTALL_COMMANDS: Record<InstallKind, string> = {
  prompt: AGENT_PROMPT,
  plugin: '/plugin marketplace add blockful/pagent\n/plugin install pagent@pagent',
  http: 'claude mcp add --scope project --transport http pagent "https://pagent.up.railway.app/mcp"',
};

class HomePage extends LitElement {
  static properties = {
    copied: { state: true },
  };

  declare copied: InstallKind | null;

  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.copied = null;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._copyTimer) clearTimeout(this._copyTimer);
  }

  private async _onCopy(which: InstallKind) {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMANDS[which]);
    } catch {
      // clipboard may be unavailable (insecure context); still flash UX
    }
    this.copied = which;
    if (this._copyTimer) clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      this.copied = null;
    }, 1800);
  }

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
        radial-gradient(ellipse at 100% 110%, rgba(21, 20, 15, 0.05), transparent 55%), var(--paper);
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
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft);
      animation: pulse 2.4s ease-in-out infinite;
    }

    @keyframes pulse {
      0%,
      100% {
        box-shadow: 0 0 0 4px var(--accent-soft);
      }
      50% {
        box-shadow: 0 0 0 7px rgba(200, 71, 47, 0.06);
      }
    }

    .hero {
      padding: clamp(56px, 10vw, 128px) 0 clamp(48px, 8vw, 96px);
      max-width: 920px;
      animation: rise 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) both;
    }

    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(14px);
      }
      to {
        opacity: 1;
        transform: none;
      }
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
      left: 0;
      right: 0;
      bottom: 0.08em;
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

    .lede strong {
      color: var(--ink);
      font-weight: 500;
    }

    .install + .install {
      margin-top: 14px;
    }

    .install {
      margin-top: 44px;
      max-width: 640px;
      background: #15140f;
      color: #ebe2d2;
      border-radius: 12px;
      border: 1px solid rgba(200, 71, 47, 0.28);
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.06) inset,
        0 0 0 6px rgba(200, 71, 47, 0.05),
        0 30px 60px -30px rgba(21, 20, 15, 0.45),
        0 12px 30px -12px rgba(21, 20, 15, 0.25);
      overflow: hidden;
      animation: rise 1.05s cubic-bezier(0.2, 0.7, 0.2, 1) both;
      animation-delay: 0.12s;
    }

    .install-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 11px 14px 11px 18px;
      background: rgba(255, 255, 255, 0.025);
      border-bottom: 1px solid rgba(235, 226, 210, 0.08);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #b4ac9b;
    }

    .install-label {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: #ebe2d2;
    }
    .install-label::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 3px rgba(200, 71, 47, 0.22);
    }

    .copy-btn {
      font: inherit;
      letter-spacing: 0.14em;
      background: transparent;
      color: #ebe2d2;
      border: 1px solid rgba(235, 226, 210, 0.2);
      padding: 5px 11px;
      border-radius: 6px;
      cursor: pointer;
      transition:
        background 0.15s ease,
        border-color 0.15s ease,
        color 0.15s ease;
    }
    .copy-btn:hover {
      background: rgba(235, 226, 210, 0.06);
      border-color: rgba(235, 226, 210, 0.34);
    }
    .copy-btn.is-copied {
      color: #b6dca5;
      border-color: rgba(155, 199, 138, 0.45);
      background: rgba(155, 199, 138, 0.08);
    }

    .install-body {
      margin: 0;
      padding: 18px 20px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 14px;
      line-height: 1.85;
      white-space: pre;
      overflow-x: auto;
    }
    .install-body.is-prompt {
      font-size: 13px;
      line-height: 1.65;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow-y: auto;
    }
    .install-body .prompt {
      color: var(--accent);
      user-select: none;
      margin-right: 12px;
    }

    .install-foot {
      padding: 11px 20px 14px;
      border-top: 1px solid rgba(235, 226, 210, 0.08);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 12px;
      color: #8c8478;
      letter-spacing: 0.02em;
    }
    .install-foot code {
      background: rgba(235, 226, 210, 0.08);
      color: #ebe2d2;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 11.5px;
    }

    .cli-fallback {
      margin-top: 28px;
      max-width: 640px;
      animation: rise 1.2s cubic-bezier(0.2, 0.7, 0.2, 1) both;
      animation-delay: 0.2s;
    }

    .cli-fallback summary {
      cursor: pointer;
      list-style: none;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 8px 0;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      transition: color 0.15s ease;
    }
    .cli-fallback summary::-webkit-details-marker {
      display: none;
    }
    .cli-fallback summary::before {
      content: '+';
      font-size: 14px;
      color: var(--accent);
      transition: transform 0.2s ease;
      display: inline-block;
      width: 12px;
      text-align: center;
    }
    .cli-fallback[open] summary::before {
      content: '−';
    }
    .cli-fallback summary:hover {
      color: var(--ink);
    }
    .cli-fallback .install {
      margin-top: 14px;
      animation: none;
    }
    .cli-fallback .install:first-of-type {
      margin-top: 16px;
    }

    .terminal {
      margin-top: 18px;
      max-width: 640px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 13px;
      background: rgba(21, 20, 15, 0.88);
      color: #ebe2d2;
      border-radius: 10px;
      padding: 14px 20px;
      box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.04) inset,
        0 18px 30px -20px rgba(21, 20, 15, 0.35);
      line-height: 1.75;
    }

    .terminal .prompt {
      color: var(--accent);
      user-select: none;
      margin-right: 10px;
    }
    .terminal .dim {
      color: #8c8478;
    }
    .terminal .cmd {
      color: #ebe2d2;
      user-select: text;
    }
    .terminal .ok {
      color: #9bc78a;
    }
    .terminal .url {
      color: #f6c89f;
      text-decoration: underline;
      text-decoration-color: rgba(246, 200, 159, 0.4);
    }
    .terminal .rule {
      height: 1px;
      background: rgba(235, 226, 210, 0.08);
      margin: 10px -22px;
    }
    .caret {
      display: inline-block;
      width: 8px;
      height: 1em;
      background: #ebe2d2;
      vertical-align: -2px;
      margin-left: 4px;
      animation: blink 1.05s steps(2, jump-none) infinite;
    }

    @keyframes blink {
      50% {
        opacity: 0;
      }
    }

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
      .steps {
        grid-template-columns: 1fr;
      }
      .step + .step {
        border-top: 1px solid var(--rule);
        border-left: 0;
      }
    }

    .step {
      padding: 36px 28px 40px;
      position: relative;
      transition: background 0.25s ease;
    }
    .step + .step {
      border-left: 1px solid var(--rule);
    }
    .step:hover {
      background: rgba(255, 255, 255, 0.35);
    }

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

    .step-link {
      color: var(--ink);
      text-decoration: none;
      border-bottom: 1px solid var(--accent);
      padding-bottom: 1px;
      transition: color 0.15s ease;
    }
    .step-link:hover {
      color: var(--accent);
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
      transition: color 0.2s ease;
    }
    .footer a:hover {
      color: var(--accent);
    }
    .footer .arrow {
      transition: transform 0.2s ease;
      display: inline-block;
    }
    .footer a:hover .arrow {
      transform: translate(2px, -2px);
    }
  `;

  render() {
    return html`
      <div class="page">
        <div class="container">
          <nav class="nav">
            <span class="badge"><span class="dot"></span>Pagent</span>
            <span>v0.9 &nbsp;/&nbsp; A2UI</span>
          </nav>

          <header class="hero">
            <p class="eyebrow">Generative UI · for terminal agents</p>
            <h1>Give your agent a <em>real UI</em>—<br />not a fake form in prose.</h1>
            <p class="lede">
              Your terminal agent posts a form spec, gets back a short URL, and waits. You open it,
              fill it out, submit. The agent reads the result and keeps going.
              <strong>One handoff. Single-shot. No host app required.</strong>
            </p>

            <div class="install" id="install" aria-labelledby="install-label">
              <div class="install-head">
                <span class="install-label" id="install-label">Install · Any agent</span>
                <button
                  type="button"
                  class="copy-btn ${this.copied === 'prompt' ? 'is-copied' : ''}"
                  @click=${() => this._onCopy('prompt')}
                  aria-label="Copy install prompt to clipboard"
                  aria-live="polite"
                >
                  ${this.copied === 'prompt' ? 'Copied ✓' : 'Copy prompt'}
                </button>
              </div>
              <pre class="install-body is-prompt"><code>${AGENT_PROMPT}</code></pre>
              <div class="install-foot">
                Paste into any chat with your agent. Cursor, Claude Code, Codex, Cline, Aider —
                anything that speaks MCP installs itself.
              </div>
            </div>

            <details class="cli-fallback">
              <summary>Or run a CLI command directly</summary>

              <div class="install" aria-labelledby="install-plugin-label">
                <div class="install-head">
                  <span class="install-label" id="install-plugin-label"
                    >Claude Code · plugin marketplace</span
                  >
                  <button
                    type="button"
                    class="copy-btn ${this.copied === 'plugin' ? 'is-copied' : ''}"
                    @click=${() => this._onCopy('plugin')}
                    aria-label="Copy plugin install commands to clipboard"
                    aria-live="polite"
                  >
                    ${this.copied === 'plugin' ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <pre
                  class="install-body"
                ><code><span class="prompt">›</span>/plugin marketplace add blockful/pagent
<span class="prompt">›</span>/plugin install pagent@pagent</code></pre>
                <div class="install-foot">
                  Verify with <code>/mcp</code> — you'll see <code>show_ui</code> &amp;
                  <code>check_result</code>.
                </div>
              </div>

              <div class="install" aria-labelledby="install-http-label">
                <div class="install-head">
                  <span class="install-label" id="install-http-label">HTTP MCP · any client</span>
                  <button
                    type="button"
                    class="copy-btn ${this.copied === 'http' ? 'is-copied' : ''}"
                    @click=${() => this._onCopy('http')}
                    aria-label="Copy HTTP MCP install command to clipboard"
                    aria-live="polite"
                  >
                    ${this.copied === 'http' ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <pre
                  class="install-body"
                ><code><span class="prompt">›</span>claude mcp add --scope project --transport http pagent "https://pagent.up.railway.app/mcp"</code></pre>
                <div class="install-foot">
                  Same tools, no local install. Works with Codex, OpenCode, Cursor, Cline, anything
                  that speaks streamable HTTP MCP.
                </div>
              </div>
            </details>

            <div class="terminal" aria-hidden="true">
              <div>
                <span class="prompt">›</span
                ><span class="dim">"ask me my favorite color via a UI"</span>
              </div>
              <div>
                <span class="prompt">↳</span
                ><span class="url">https://agent-ui-session.vercel.app/4f2a…b13c</span
                ><span class="caret"></span>
              </div>
            </div>
          </header>

          <p class="section-label"><span>How it works</span><span>three steps</span></p>

          <section class="steps">
            <article class="step">
              <div class="step-num">i.</div>
              <h3>Install in your agent</h3>
              <p>
                Copy the prompt from the <a href="#install" class="step-link">panel above</a> into
                any agent chat. The agent installs the MCP (<code>show_ui</code>,
                <code>check_result</code>) and reads the skill that teaches it when to reach for a
                form.
              </p>
            </article>
            <article class="step">
              <div class="step-num">ii.</div>
              <h3>Ask your agent</h3>
              <p>
                Try:
                <code>"Use the pagent skill to ask me my favorite color via a UI form."</code> The
                skill teaches the agent the polling pattern; the MCP gives it the tools.
              </p>
            </article>
            <article class="step">
              <div class="step-num">iii.</div>
              <h3>Open. Submit. Continue.</h3>
              <p>
                The agent prints a URL. You open it, fill the form, submit.
                <code>check_result</code> hands the answer back and the conversation keeps going.
              </p>
            </article>
          </section>

          <div class="footer">
            <span>Hono · Vite · A2UI · Supabase</span>
            <a href="https://github.com/blockful/pagent" target="_blank" rel="noopener noreferrer">
              View on GitHub <span class="arrow">↗</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('home-page', HomePage);
