import { css } from 'lit';

export const productDialogStyles = css`
  dialog {
    width: min(560px, calc(100vw - var(--pg-space-8)));
    max-height: calc(100dvh - var(--pg-space-8));
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--pg-rule);
    border-radius: 14px;
    color: var(--pg-ink);
    background: var(--pg-surface);
    box-shadow: 0 24px 70px -36px rgba(21, 20, 15, 0.55);
  }
  dialog[open] {
    animation: dialog-in 200ms ease-in-out both;
  }
  dialog::backdrop {
    background: var(--pg-backdrop);
    backdrop-filter: blur(3px);
  }
  .dialog-body {
    display: grid;
    gap: var(--pg-space-5);
    padding: var(--pg-space-6);
  }
  .editor-dialog {
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 0;
    max-height: calc(100dvh - var(--pg-space-8));
    padding: 0;
  }
  .dialog-scroll {
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--pg-space-6);
  }
  .dialog-actions {
    padding: var(--pg-space-4) var(--pg-space-6);
    border-top: 1px solid var(--pg-rule);
    background: var(--pg-surface);
  }
  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: scale(0.98);
    }
  }
`;
