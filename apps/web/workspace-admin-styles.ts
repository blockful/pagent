import { css } from 'lit';

export const workspaceAdminStyles = css`
  .admin-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
    gap: var(--pg-space-5);
    align-items: start;
  }
  .section-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--pg-space-4);
  }
  .section-head p,
  .surface p {
    margin-block: 0;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--pg-space-3);
    margin-bottom: var(--pg-space-5);
  }
  .summary-card {
    display: grid;
    gap: var(--pg-space-1);
    padding: var(--pg-space-4);
    border: 1px solid var(--pg-rule);
    border-radius: 10px;
    background: var(--pg-surface);
  }
  .summary-card strong {
    font: 400 var(--pg-type-metric) / 1 var(--pg-font-display);
    font-variant-numeric: tabular-nums;
  }
  .pages-section {
    margin-bottom: var(--pg-space-5);
  }
  .inline-form {
    display: grid;
    grid-template-columns: minmax(190px, 1fr) minmax(130px, 0.35fr) auto;
    gap: var(--pg-space-3);
    align-items: end;
  }
  .member-name {
    display: grid;
    gap: var(--pg-space-1);
  }
  .member-name small {
    color: var(--pg-ink-secondary);
  }
  .row-action {
    text-align: right;
    white-space: nowrap;
  }
  .summary-list {
    display: grid;
    gap: var(--pg-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .summary-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--pg-space-3);
    padding-block: var(--pg-space-2);
    border-bottom: 1px solid var(--pg-rule);
  }
  .summary-list li:last-child {
    border-bottom: 0;
  }
  .domain-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--pg-space-2);
  }
  .policy-fields {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--pg-space-3);
    align-items: end;
  }
  .audit-action {
    font-weight: 600;
  }
  .audit-detail {
    margin-top: var(--pg-space-1);
    color: var(--pg-ink-secondary);
    font-size: var(--pg-type-sm);
  }
  .compact-empty {
    display: grid;
    gap: var(--pg-space-2);
    padding: var(--pg-space-5) 0;
    color: var(--pg-ink-secondary);
  }
  .page-error {
    max-width: 720px;
    margin: var(--pg-space-16) auto;
  }
  @media (max-width: 900px) {
    .admin-grid,
    .summary-grid,
    .inline-form,
    .policy-fields {
      grid-template-columns: 1fr;
    }
    .row-action {
      text-align: left;
    }
    .page-head > .badge {
      justify-self: start;
    }
    .admin-grid td {
      grid-template-columns: minmax(76px, 0.35fr) minmax(0, 1fr);
    }
  }
`;
