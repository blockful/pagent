import { css } from 'lit';

export const productBaseStyles = css`
  :host {
    --pg-canvas: #f4ede1;
    --pg-surface: #fffdf8;
    --pg-surface-subtle: #ebe2d2;
    --pg-ink: #15140f;
    --pg-ink-secondary: #6e685c;
    --pg-rule: #d8cdb9;
    --pg-accent: #c8472f;
    --pg-accent-strong: #9f3524;
    --pg-success-surface: #edf3ec;
    --pg-success-ink: #346538;
    --pg-warning-surface: #fbf3db;
    --pg-warning-ink: #7d5700;
    --pg-error-surface: #fdebec;
    --pg-error-ink: #8f2c2a;
    --pg-info-surface: #e1f3fe;
    --pg-info-ink: #1f628c;
    --pg-focus: #7b2f20;
    --pg-backdrop: rgba(21, 20, 15, 0.45);
    --pg-slide-stage: #d8cdb9;
    --pg-slide-surface: #fff;
    --pg-slide-ink: #15140f;
    --pg-presentation: #090906;
    --pg-slide-shadow: 0 22px 50px -30px rgba(21, 20, 15, 0.65);
    --pg-font-ui: 'Outfit', system-ui, -apple-system, sans-serif;
    --pg-font-display: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    --pg-font-metadata: 'JetBrains Mono', ui-monospace, monospace;
    --pg-type-xs: 0.6875rem;
    --pg-type-brand: 0.75rem;
    --pg-type-sm: 0.875rem;
    --pg-type-body: 1rem;
    --pg-type-lede: 1.125rem;
    --pg-type-h1: 2.25rem;
    --pg-type-h3: 1.125rem;
    --pg-type-h2: 1.5rem;
    --pg-type-metric: 2rem;
    --pg-type-display: clamp(2.5rem, 6vw, 4.5rem);
    --pg-type-slide-body: clamp(0.6875rem, 3.5cqw, 1.125rem);
    --pg-type-slide-heading: clamp(1.5rem, 8cqw, 2.5rem);
    --pg-leading-tight: 1;
    --pg-leading-body: 1.55;
    --pg-space-1: 4px;
    --pg-space-2: 8px;
    --pg-space-3: 12px;
    --pg-space-4: 16px;
    --pg-space-5: 20px;
    --pg-space-6: 24px;
    --pg-space-8: 32px;
    --pg-space-10: 40px;
    --pg-space-12: 48px;
    --pg-space-16: 64px;
    display: block;
    min-height: 100%;
    font-family: var(--pg-font-ui);
    font-size: var(--pg-type-body);
    line-height: var(--pg-leading-body);
    color: var(--pg-ink);
    background: var(--pg-canvas);
  }
  * {
    box-sizing: border-box;
  }
  a {
    color: inherit;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
  }
  button,
  a,
  input,
  select,
  textarea {
    outline: none;
  }
  button:focus-visible,
  a:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  [role='tab']:focus-visible {
    box-shadow:
      0 0 0 3px var(--pg-canvas),
      0 0 0 5px var(--pg-focus);
  }
  .skip-link {
    position: fixed;
    inset: var(--pg-space-3) auto auto var(--pg-space-3);
    z-index: 50;
    transform: translateY(-180%);
    padding: var(--pg-space-2) var(--pg-space-4);
    background: var(--pg-ink);
    color: var(--pg-canvas);
  }
  .skip-link:focus {
    transform: none;
  }
  .shell {
    min-height: 100vh;
    background:
      radial-gradient(ellipse at 10% 0%, rgba(200, 71, 47, 0.08), transparent 42%), var(--pg-canvas);
  }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--pg-space-4);
    min-height: 64px;
    padding: var(--pg-space-3) clamp(var(--pg-space-5), 4vw, var(--pg-space-12));
    border-bottom: 1px solid var(--pg-rule);
    background: color-mix(in srgb, var(--pg-canvas) 92%, transparent);
    backdrop-filter: blur(14px);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--pg-space-2);
    font: 600 var(--pg-type-brand) / 1 var(--pg-font-metadata);
    letter-spacing: 0.12em;
    text-decoration: none;
    text-transform: uppercase;
  }
  .brand-mark {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--pg-accent);
    box-shadow: 0 0 0 var(--pg-space-1) rgba(200, 71, 47, 0.12);
  }
  .page {
    width: min(1440px, 100%);
    margin: 0 auto;
    padding: clamp(var(--pg-space-8), 5vw, var(--pg-space-16))
      clamp(var(--pg-space-5), 4vw, var(--pg-space-12)) calc(var(--pg-space-16) + var(--pg-space-4));
  }
  .eyebrow {
    margin: 0 0 var(--pg-space-3);
    color: var(--pg-accent);
    font: 600 var(--pg-type-xs) / 1.4 var(--pg-font-metadata);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  h1,
  h2,
  h3,
  p {
    overflow-wrap: break-word;
    word-break: normal;
    line-break: auto;
  }
  :host-context(html[lang='ko']) :is(h1, h2, h3, p) {
    overflow-wrap: normal;
    word-break: keep-all;
  }
  :host-context(html[lang='ja']) :is(h1, h2, h3, p),
  :host-context(html[lang='zh']) :is(h1, h2, h3, p) {
    line-break: strict;
  }
  h1 {
    margin: 0;
    font: 400 var(--pg-type-h1) / 1.12 var(--pg-font-display);
    letter-spacing: -0.018em;
  }
  .display-title {
    font: 400 var(--pg-type-display) / var(--pg-leading-tight) var(--pg-font-display);
    letter-spacing: -0.02em;
  }
  h2 {
    margin: 0;
    font-size: var(--pg-type-h2);
    line-height: 1.25;
    letter-spacing: -0.01em;
  }
  h3 {
    margin: 0;
    font-size: var(--pg-type-h3);
    line-height: 1.35;
  }
  .lede,
  .muted {
    color: var(--pg-ink-secondary);
  }
  .lede {
    max-width: 66ch;
    font-size: var(--pg-type-lede);
    line-height: 1.6;
  }
  .mono {
    font-family: var(--pg-font-metadata);
    font-variant-numeric: tabular-nums;
  }
  .cluster,
  .actions {
    display: flex;
    align-items: center;
    gap: var(--pg-space-3);
    flex-wrap: wrap;
  }
  .actions {
    justify-content: flex-end;
  }
  .stack {
    display: grid;
    gap: var(--pg-space-4);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --pg-canvas: #15140f;
      --pg-surface: #201e18;
      --pg-surface-subtle: #29261f;
      --pg-ink: #f4ede1;
      --pg-ink-secondary: #c8bead;
      --pg-rule: #474137;
      --pg-accent: #e36b52;
      --pg-accent-strong: #f28770;
      --pg-success-surface: #1d2b1f;
      --pg-success-ink: #a7d2a7;
      --pg-warning-surface: #302817;
      --pg-warning-ink: #f1cf79;
      --pg-error-surface: #351b1c;
      --pg-error-ink: #f2a4a1;
      --pg-info-surface: #172833;
      --pg-info-ink: #9ed3f1;
      --pg-focus: #f28770;
      --pg-backdrop: rgba(0, 0, 0, 0.72);
    }
  }
`;
