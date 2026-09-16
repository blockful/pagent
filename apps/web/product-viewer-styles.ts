import { css } from 'lit';

export const productViewerStyles = css`
  .viewer-shell {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100dvh;
    background: var(--pg-ink);
    color: var(--pg-surface);
  }
  .viewer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--pg-space-3);
    min-height: 64px;
    padding: var(--pg-space-3) clamp(var(--pg-space-3), 3vw, var(--pg-space-8));
  }
  .viewer-stage {
    min-height: 0;
    display: grid;
    place-items: center;
    padding: clamp(var(--pg-space-2), 2vw, var(--pg-space-6));
    background: var(--pg-presentation);
  }
  .viewer-stage .slide-canvas {
    max-height: 100%;
    overflow: hidden;
  }
  .viewer-controls {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--pg-space-3);
    padding: var(--pg-space-3) clamp(var(--pg-space-3), 3vw, var(--pg-space-8)) var(--pg-space-4);
  }
  .viewer-bar .button.quiet {
    color: inherit;
    border-color: color-mix(in srgb, currentColor 55%, transparent);
    background: transparent;
  }
  .viewer-bar .button.quiet:hover {
    border-color: currentColor;
    background: color-mix(in srgb, currentColor 14%, transparent);
  }
`;
