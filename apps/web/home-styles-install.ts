import { css } from 'lit';

export const homeInstallStyles = css`
  .install + .install {
    margin-top: 14px;
  }

  .install {
    margin-top: 44px;
    max-width: 720px;
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
  }
  /* Command keywords stay selectable — every token inside .install-body is
     semantically part of what the user copies into a shell. Only the
     decorative glyphs in .terminal (›, ↳) are user-select: none. */
  .install-body .kw {
    color: var(--accent);
  }
  .install-body .cmt {
    color: #8c8478;
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
  .install-foot div + div {
    margin-top: 5px;
  }

  .demo-cta {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-top: 36px;
    padding: 11px 18px;
    border: 1px solid var(--accent);
    border-radius: 10px;
    color: var(--accent);
    text-decoration: none;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    transition:
      background 0.15s ease,
      color 0.15s ease;
    animation: rise 1s cubic-bezier(0.2, 0.7, 0.2, 1) both;
    animation-delay: 0.08s;
  }
  .demo-cta:hover {
    background: var(--accent);
    color: var(--paper);
  }
  .demo-cta .arrow {
    transition: transform 0.15s ease;
  }
  .demo-cta:hover .arrow {
    transform: translateX(3px);
  }

  .nav-link {
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px solid var(--accent);
    padding-bottom: 1px;
    transition: color 0.15s ease;
  }
  .nav-link:hover {
    color: var(--accent);
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
    margin: 10px -20px;
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
`;
