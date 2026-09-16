import { css } from 'lit';

export const homeSectionStyles = css`
  .section-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-family: var(--pg-font-metadata);
    font-size: var(--pg-type-xs);
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--pg-ink-secondary);
    margin: 0 0 28px;
  }

  .section-label::before {
    content: '— ';
    margin-right: var(--pg-space-2);
    color: var(--pg-accent);
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    border-top: 1px solid var(--pg-rule);
    border-bottom: 1px solid var(--pg-rule);
  }

  @media (max-width: 760px) {
    .steps {
      grid-template-columns: 1fr;
    }
    .step + .step {
      border-top: 1px solid var(--pg-rule);
      border-left: 0;
    }
  }

  .step {
    padding: 36px 28px var(--pg-space-10);
    position: relative;
    transition: background 0.25s ease;
  }
  .step + .step {
    border-left: 1px solid var(--pg-rule);
  }
  .step:hover {
    background: rgba(var(--pg-home-highlight-rgb), 0.35);
  }

  .step-num {
    font-family: var(--pg-font-display);
    font-style: italic;
    font-weight: 400;
    font-size: 56px;
    color: var(--pg-accent);
    line-height: 1;
    margin-bottom: 14px;
    letter-spacing: -0.02em;
  }

  .step h3 {
    font-family: var(--pg-font-ui);
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.005em;
    margin: 0 0 10px;
  }

  .step p {
    font-size: 14.5px;
    line-height: 1.55;
    color: var(--pg-ink-secondary);
    margin: 0;
  }

  .step-link {
    color: var(--pg-ink);
    text-decoration: none;
    border-bottom: 1px solid var(--pg-accent);
    padding-bottom: 1px;
    transition: color 0.15s ease;
  }
  .step-link:hover {
    color: var(--pg-accent);
  }

  .step code {
    font-family: var(--pg-font-metadata);
    font-size: 12.5px;
    background: rgba(var(--pg-ink-rgb), 0.06);
    color: var(--pg-ink);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid rgba(var(--pg-ink-rgb), 0.05);
  }

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--pg-space-4);
    flex-wrap: wrap;
    padding-top: 28px;
    font-family: var(--pg-font-metadata);
    font-size: 11.5px;
    color: var(--pg-ink-secondary);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .footer a {
    color: var(--pg-ink);
    text-decoration: none;
    border-bottom: 1px solid currentColor;
    padding-bottom: 1px;
    display: inline-flex;
    align-items: center;
    gap: var(--pg-space-2);
    transition: color 0.2s ease;
  }
  .footer a:hover {
    color: var(--pg-accent);
  }
  .footer .arrow {
    transition: transform 0.2s ease;
    display: inline-block;
  }
  .footer a:hover .arrow {
    transform: translate(2px, -2px);
  }
`;
