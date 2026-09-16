import { css } from 'lit';

export const homeInstallStyles = css`
  .install + .install {
    margin-top: 14px;
  }

  .install {
    margin-top: 44px;
    max-width: 720px;
    background: var(--pg-ink);
    color: var(--pg-surface-subtle);
    border-radius: var(--pg-home-radius-panel);
    border: 1px solid rgba(var(--pg-accent-rgb), 0.28);
    box-shadow: var(--pg-home-shadow-panel);
    overflow: hidden;
    animation: rise 1.05s cubic-bezier(0.2, 0.7, 0.2, 1) both;
    animation-delay: 0.12s;
  }

  .install-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--pg-space-3);
    padding: 11px 14px 11px 18px;
    background: rgba(var(--pg-home-highlight-rgb), 0.025);
    border-bottom: 1px solid rgba(var(--pg-surface-subtle-rgb), 0.08);
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-type-xs);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--pg-home-terminal-label);
  }

  .install-label {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--pg-surface-subtle);
  }
  .install-label::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pg-accent);
    box-shadow: var(--pg-home-shadow-status);
  }

  .copy-btn {
    font: inherit;
    letter-spacing: 0.14em;
    background: transparent;
    color: var(--pg-surface-subtle);
    border: 1px solid rgba(var(--pg-surface-subtle-rgb), 0.2);
    padding: 5px 11px;
    border-radius: 6px;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .copy-btn:hover {
    background: rgba(var(--pg-surface-subtle-rgb), 0.06);
    border-color: rgba(var(--pg-surface-subtle-rgb), 0.34);
  }
  .copy-btn.is-copied {
    color: var(--pg-home-terminal-copied);
    border-color: rgba(var(--pg-home-terminal-success-rgb), 0.45);
    background: rgba(var(--pg-home-terminal-success-rgb), 0.08);
  }

  .install-body {
    margin: 0;
    padding: 18px var(--pg-space-5);
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-type-sm);
    line-height: 1.85;
    white-space: pre;
    overflow-x: auto;
  }
  .install-body.is-prompt {
    font-size: var(--pg-home-type-terminal);
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Command keywords stay selectable — every token inside .install-body is
     semantically part of what the user copies into a shell. Only the
     decorative glyphs in .terminal (›, ↳) are user-select: none. */
  .install-body .kw {
    color: var(--pg-accent);
  }
  .install-body .cmt {
    color: var(--pg-home-terminal-muted);
  }

  .install-foot {
    padding: 11px 20px 14px;
    border-top: 1px solid rgba(var(--pg-surface-subtle-rgb), 0.08);
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-type-brand);
    color: var(--pg-home-terminal-muted);
    letter-spacing: 0.02em;
  }
  .install-foot code {
    background: rgba(var(--pg-surface-subtle-rgb), 0.08);
    color: var(--pg-surface-subtle);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11.5px;
  }
  .install-foot div + div {
    margin-top: 5px;
  }

  .hero-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 36px;
    animation: rise 1s cubic-bezier(0.2, 0.7, 0.2, 1) both;
    animation-delay: 0.08s;
  }

  .demo-cta,
  .workspace-cta,
  .sign-in-cta {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 11px 18px;
    border-radius: var(--pg-home-radius-action);
    text-decoration: none;
    font-family: var(--pg-font-metadata);
    font-size: 12.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    transition:
      background 0.15s ease,
      color 0.15s ease,
      border-color 0.15s ease;
  }
  .workspace-cta {
    border: 1px solid var(--pg-accent-strong);
    background: var(--pg-accent-strong);
    color: var(--pg-canvas);
  }
  .workspace-cta:hover {
    background: var(--pg-ink);
    border-color: var(--pg-ink);
  }
  .demo-cta {
    border: 1px solid var(--pg-accent-strong);
    color: var(--pg-accent-strong);
  }
  .demo-cta:hover {
    background: var(--pg-accent-strong);
    color: var(--pg-canvas);
  }
  .sign-in-cta {
    border: 1px solid transparent;
    color: var(--pg-ink);
    padding-inline: var(--pg-space-1);
    border-radius: 0;
    border-bottom-color: var(--pg-ink);
  }
  .sign-in-cta:hover {
    color: var(--pg-accent-strong);
    border-bottom-color: var(--pg-accent-strong);
  }
  .demo-cta:focus-visible,
  .workspace-cta:focus-visible,
  .sign-in-cta:focus-visible {
    outline: 3px solid var(--pg-accent-strong);
    outline-offset: 3px;
  }
  .workspace-cta .arrow {
    transition: transform 0.15s ease;
  }
  .workspace-cta:hover .arrow {
    transform: translateX(3px);
  }

  .nav-link {
    color: var(--pg-ink);
    text-decoration: none;
    border-bottom: 1px solid var(--pg-accent);
    padding-bottom: 1px;
    transition: color 0.15s ease;
  }
  .nav-link:hover {
    color: var(--pg-accent);
  }

  .terminal {
    margin-top: 18px;
    max-width: 640px;
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-home-type-terminal);
    background: rgba(var(--pg-ink-rgb), 0.88);
    color: var(--pg-surface-subtle);
    border-radius: var(--pg-home-radius-action);
    padding: 14px var(--pg-space-5);
    box-shadow: var(--pg-home-shadow-terminal);
    line-height: 1.75;
  }

  .terminal .prompt {
    color: var(--pg-accent);
    user-select: none;
    margin-right: 10px;
  }
  .terminal .dim {
    color: var(--pg-home-terminal-muted);
  }
  .terminal .cmd {
    color: var(--pg-surface-subtle);
    user-select: text;
  }
  .terminal .ok {
    color: var(--pg-home-terminal-success);
  }
  .terminal .url {
    color: var(--pg-home-terminal-url);
    text-decoration: underline;
    text-decoration-color: rgba(var(--pg-home-terminal-url-rgb), 0.4);
  }
  .terminal .rule {
    height: 1px;
    background: rgba(var(--pg-surface-subtle-rgb), 0.08);
    margin: 10px calc(-1 * var(--pg-space-5));
  }
  .caret {
    display: inline-block;
    width: 8px;
    height: 1em;
    background: var(--pg-surface-subtle);
    vertical-align: -2px;
    margin-left: var(--pg-space-1);
    animation: blink 1.05s steps(2, jump-none) infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
`;
