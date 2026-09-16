import { css } from 'lit';
import { productBaseStyles } from './product-base-styles.ts';

export const productStyles = [
  productBaseStyles,
  css`
    .button {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--pg-space-2);
      padding: var(--pg-space-2) var(--pg-space-4);
      border: 1px solid var(--pg-ink);
      border-radius: 8px;
      background: var(--pg-ink);
      color: var(--pg-surface);
      cursor: pointer;
      font-weight: 600;
      text-decoration: none;
      transition:
        transform 120ms ease-out,
        opacity 120ms ease-out,
        background 120ms ease-out;
    }
    .button:hover {
      background: var(--pg-accent-strong);
      border-color: var(--pg-accent-strong);
    }
    .button:active {
      transform: scale(0.98);
    }
    .button.secondary,
    .button.quiet {
      color: var(--pg-ink);
      background: var(--pg-surface);
      border-color: var(--pg-rule);
    }
    .button.quiet {
      background: transparent;
      border-color: transparent;
    }
    .button.destructive {
      background: var(--pg-error-ink);
      border-color: var(--pg-error-ink);
    }
    .button:disabled,
    .button[aria-busy='true'] {
      cursor: wait;
      opacity: 0.55;
    }
    .icon-button {
      width: 44px;
      padding: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: var(--pg-space-1) var(--pg-space-2);
      border: 1px solid var(--pg-rule);
      border-radius: 999px;
      color: var(--pg-ink-secondary);
      background: var(--pg-surface);
      font: 600 var(--pg-type-xs) / 1.3 var(--pg-font-metadata);
    }
    .badge.active,
    .badge.authenticated {
      color: var(--pg-success-ink);
      background: var(--pg-success-surface);
    }
    .badge.unverified,
    .notice.warning {
      color: var(--pg-warning-ink);
      background: var(--pg-warning-surface);
    }
    .badge.revoked,
    .badge.expired,
    .notice.error {
      color: var(--pg-error-ink);
      background: var(--pg-error-surface);
    }
    .surface {
      border: 1px solid var(--pg-rule);
      border-radius: 12px;
      background: var(--pg-surface);
      padding: clamp(var(--pg-space-5), 3vw, var(--pg-space-8));
    }
    .notice {
      padding: var(--pg-space-3) var(--pg-space-4);
      border: 1px solid currentColor;
      border-radius: 8px;
      color: var(--pg-info-ink);
      background: var(--pg-info-surface);
      line-height: var(--pg-leading-body);
    }
    .field {
      display: grid;
      gap: var(--pg-space-2);
    }
    .field label,
    legend {
      font-weight: 600;
    }
    .field small,
    .caption {
      color: var(--pg-ink-secondary);
      font-size: var(--pg-type-sm);
      line-height: 1.45;
    }
    input,
    select,
    textarea {
      width: 100%;
      min-height: 44px;
      padding: var(--pg-space-3);
      border: 1px solid var(--pg-rule);
      border-radius: 7px;
      background: var(--pg-surface);
      color: var(--pg-ink);
    }
    textarea {
      min-height: 96px;
      resize: vertical;
    }
    input[type='radio'],
    input[type='checkbox'] {
      width: 20px;
      min-height: 20px;
      accent-color: var(--pg-accent);
    }
    .choice {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: var(--pg-space-3);
      align-items: start;
      padding: var(--pg-space-3);
      border: 1px solid var(--pg-rule);
      border-radius: 8px;
      cursor: pointer;
    }
    .choice:has(input:checked) {
      border-color: var(--pg-accent);
      background: color-mix(in srgb, var(--pg-accent) 7%, var(--pg-surface));
    }
    .loading-line {
      height: 14px;
      border-radius: 4px;
      background: var(--pg-surface-subtle);
      animation: pulse-opacity 1.4s ease-in-out infinite alternate;
    }
    @keyframes pulse-opacity {
      to {
        opacity: 0.45;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        scroll-behavior: auto !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      .button:active {
        transform: none;
      }
    }
  `,
];
