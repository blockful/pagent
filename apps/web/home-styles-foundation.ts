import { css } from 'lit';

export const homeFoundationStyles = css`
  :host {
    display: block;
    font-family: var(--pg-font-ui);
    --pg-canvas: #f4ede1;
    --pg-surface-subtle-rgb: 235, 226, 210;
    --pg-surface-subtle: rgb(var(--pg-surface-subtle-rgb));
    --pg-home-highlight-rgb: 255, 255, 255;
    --pg-ink-rgb: 21, 20, 15;
    --pg-ink: rgb(var(--pg-ink-rgb));
    --pg-ink-secondary: #6e685c;
    --pg-rule: #d8cdb9;
    --pg-accent-rgb: 200, 71, 47;
    --pg-accent: rgb(var(--pg-accent-rgb));
    --pg-accent-strong: #9f3524;
    --pg-font-ui: 'Outfit', system-ui, -apple-system, sans-serif;
    --pg-font-display: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    --pg-font-metadata: 'JetBrains Mono', ui-monospace, monospace;
    --pg-type-xs: 0.6875rem;
    --pg-type-brand: 0.75rem;
    --pg-type-sm: 0.875rem;
    --pg-space-1: 4px;
    --pg-space-2: 8px;
    --pg-space-3: 12px;
    --pg-space-4: 16px;
    --pg-space-5: 20px;
    --pg-space-10: 40px;
    --pg-space-12: 48px;
    --pg-space-16: 64px;
    --pg-home-copy: #3a352d;
    --pg-home-terminal-label: #b4ac9b;
    --pg-home-terminal-muted: #8c8478;
    --pg-home-terminal-success-rgb: 155, 199, 138;
    --pg-home-terminal-success: rgb(var(--pg-home-terminal-success-rgb));
    --pg-home-terminal-copied: #b6dca5;
    --pg-home-terminal-url-rgb: 246, 200, 159;
    --pg-home-terminal-url: rgb(var(--pg-home-terminal-url-rgb));
    --pg-home-type-terminal: 0.8125rem;
    --pg-home-type-lede: clamp(1.0625rem, 1.4vw, 1.1875rem);
    --pg-home-type-display: clamp(2.75rem, 7.5vw, 6.5rem);
    --pg-home-radius-action: 10px;
    --pg-home-radius-panel: 12px;
    --pg-home-shadow-pulse: 0 0 0 4px rgba(var(--pg-accent-rgb), 0.12);
    --pg-home-shadow-pulse-wide: 0 0 0 7px rgba(var(--pg-accent-rgb), 0.06);
    --pg-home-shadow-status: 0 0 0 3px rgba(var(--pg-accent-rgb), 0.22);
    --pg-home-shadow-panel:
      0 1px 0 rgba(var(--pg-home-highlight-rgb), 0.06) inset,
      0 0 0 6px rgba(var(--pg-accent-rgb), 0.05), 0 30px 60px -30px rgba(var(--pg-ink-rgb), 0.45),
      0 12px 30px -12px rgba(var(--pg-ink-rgb), 0.25);
    --pg-home-shadow-terminal:
      0 1px 0 rgba(var(--pg-home-highlight-rgb), 0.04) inset,
      0 18px 30px -20px rgba(var(--pg-ink-rgb), 0.35);
  }

  .page {
    min-height: 100vh;
    background:
      radial-gradient(ellipse at 12% -10%, rgba(var(--pg-accent-rgb), 0.08), transparent 55%),
      radial-gradient(ellipse at 100% 110%, rgba(var(--pg-ink-rgb), 0.05), transparent 55%),
      var(--pg-canvas);
    color: var(--pg-ink);
    padding: clamp(28px, 5vw, var(--pg-space-16)) clamp(var(--pg-space-5), 5vw, 56px);
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
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-type-brand);
    letter-spacing: 0.08em;
    color: var(--pg-ink-secondary);
    padding-bottom: var(--pg-space-5);
    border-bottom: 1px solid var(--pg-rule);
    text-transform: uppercase;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--pg-ink);
    font-weight: 500;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--pg-accent);
    box-shadow: var(--pg-home-shadow-pulse);
    animation: pulse 2.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      box-shadow: var(--pg-home-shadow-pulse);
    }
    50% {
      box-shadow: var(--pg-home-shadow-pulse-wide);
    }
  }

  .hero {
    padding: clamp(56px, 10vw, 128px) 0 clamp(var(--pg-space-12), 8vw, 96px);
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
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-type-brand);
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--pg-accent-strong);
    margin: 0 0 28px;
    display: inline-flex;
    align-items: center;
    gap: var(--pg-space-3);
  }

  .eyebrow::before {
    content: '';
    width: 28px;
    height: 1px;
    background: var(--pg-accent);
  }

  h1 {
    font-family: var(--pg-font-display);
    font-weight: 400;
    font-size: var(--pg-home-type-display);
    line-height: 0.96;
    letter-spacing: -0.018em;
    margin: 0 0 36px;
  }

  h1 em {
    font-style: italic;
    color: var(--pg-accent);
    position: relative;
  }

  h1 em::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0.08em;
    height: 0.08em;
    background: var(--pg-accent);
    opacity: 0.18;
    transform: skewX(-12deg);
  }

  .lede {
    max-width: 620px;
    font-size: var(--pg-home-type-lede);
    line-height: 1.55;
    color: var(--pg-home-copy);
    margin: 0;
  }

  .lede strong {
    color: var(--pg-ink);
    font-weight: 500;
  }

  .lede-followup {
    margin-top: var(--pg-space-4);
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
