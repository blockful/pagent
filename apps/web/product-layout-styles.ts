import { css } from 'lit';
import { productDialogStyles } from './product-dialog-styles.ts';

export const productLayoutStyles = [
  productDialogStyles,
  css`
    @media (min-width: 901px) {
      .product-shell {
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        grid-template-rows: auto 1fr;
      }
      .product-shell > .topbar {
        grid-column: 1 / -1;
      }
      .product-shell > product-navigation {
        grid-column: 1;
        grid-row: 2;
      }
      .product-shell > .page {
        grid-column: 2;
        grid-row: 2;
      }
    }
    .page-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--pg-space-6);
      align-items: end;
      margin-bottom: var(--pg-space-8);
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) repeat(2, minmax(150px, 220px));
      gap: var(--pg-space-3);
      margin-bottom: var(--pg-space-5);
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
      gap: var(--pg-space-3);
    }
    .metric {
      display: grid;
      gap: var(--pg-space-2);
    }
    .metric strong {
      font: 400 var(--pg-type-metric) / 1 var(--pg-font-display);
      font-variant-numeric: tabular-nums;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--pg-rule);
      border-radius: 12px;
      background: var(--pg-surface);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th,
    td {
      padding: var(--pg-space-3) var(--pg-space-4);
      border-bottom: 1px solid var(--pg-rule);
      vertical-align: top;
    }
    th {
      color: var(--pg-ink-secondary);
      font: 600 var(--pg-type-xs) / 1.4 var(--pg-font-metadata);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    tbody tr:last-child td {
      border-bottom: 0;
    }
    tbody tr:hover {
      background: color-mix(in srgb, var(--pg-surface-subtle) 55%, transparent);
    }
    .primary-link {
      font-weight: 650;
      text-decoration-thickness: 1px;
      text-decoration-color: var(--pg-accent);
      text-underline-offset: var(--pg-space-1);
    }
    .tabs {
      display: flex;
      gap: var(--pg-space-1);
      overflow-x: auto;
      padding: var(--pg-space-1);
      border: 1px solid var(--pg-rule);
      border-radius: 9px;
      background: var(--pg-surface);
      scrollbar-width: thin;
    }
    .tab {
      min-height: 44px;
      flex: 0 0 auto;
      padding: var(--pg-space-2) var(--pg-space-3);
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--pg-ink-secondary);
      cursor: pointer;
      font-weight: 600;
    }
    .tab[aria-selected='true'] {
      background: var(--pg-ink);
      color: var(--pg-surface);
    }
    .tab-panel {
      margin-top: var(--pg-space-5);
      animation: panel-in 150ms ease-out both;
    }
    @keyframes panel-in {
      from {
        opacity: 0;
        transform: translateY(3px);
      }
    }
    .empty {
      display: grid;
      place-items: start;
      gap: var(--pg-space-3);
      min-height: 220px;
      align-content: center;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(260px, 0.5fr);
      gap: var(--pg-space-5);
    }
    .slide-stage {
      display: grid;
      place-items: center;
      min-height: 420px;
      padding: clamp(var(--pg-space-5), 4vw, var(--pg-space-10));
      overflow: auto;
      border: 1px solid var(--pg-rule);
      border-radius: 12px;
      background: var(--pg-slide-stage);
    }
    .slide-canvas {
      width: min(960px, 100%);
      aspect-ratio: 16 / 9;
      overflow: auto;
      background: var(--pg-slide-surface);
      color: var(--pg-slide-ink);
      box-shadow: var(--pg-slide-shadow);
    }
    .slide-canvas > * {
      min-height: 100%;
      padding: clamp(var(--pg-space-5), 5vw, var(--pg-space-16));
    }
    @media (max-width: 900px) {
      .page-head,
      .detail-grid {
        grid-template-columns: 1fr;
        align-items: start;
      }
      .toolbar {
        grid-template-columns: 1fr;
      }
      .actions {
        justify-content: flex-start;
      }
      .table-wrap {
        border: 0;
        background: transparent;
        overflow: visible;
      }
      table,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
      }
      thead {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
      tbody {
        display: grid;
        gap: var(--pg-space-3);
      }
      tbody tr {
        padding: var(--pg-space-4);
        border: 1px solid var(--pg-rule);
        border-radius: 10px;
        background: var(--pg-surface);
      }
      td {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(90px, 0.45fr) minmax(0, 1fr);
        gap: var(--pg-space-3);
        padding: var(--pg-space-2) 0;
        border: 0;
        overflow-wrap: anywhere;
      }
      td > * {
        min-width: 0;
      }
      td::before {
        content: attr(data-label);
        color: var(--pg-ink-secondary);
        font: 600 var(--pg-type-xs) / 1.5 var(--pg-font-metadata);
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .slide-stage {
        min-height: 280px;
      }
      .slide-canvas {
        container-type: inline-size;
        overflow: hidden;
      }
      .slide-canvas > * {
        box-sizing: border-box;
        padding: clamp(var(--pg-space-4), 5cqw, var(--pg-space-8)) !important;
      }
      .slide-canvas h1 {
        margin-block: 0.35em !important;
        font-size: var(--pg-type-slide-heading) !important;
        line-height: 1.05 !important;
      }
      .slide-canvas p {
        margin-block: 0.3em !important;
        font-size: var(--pg-type-slide-body) !important;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .tab-panel,
      dialog[open] {
        animation: none;
      }
    }
  `,
];
