import { css } from 'lit';

export const homeFoundationStyles = css`
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
`;
