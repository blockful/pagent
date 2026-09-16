import { css } from 'lit';

export const agentUIStyles = css`
  :host {
    display: block;
  }
  .status {
    color: var(--muted, #777);
    text-align: center;
    padding: 24px;
    font-size: 14px;
  }
  .pending {
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    padding: 64px 16px;
  }
  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(127, 127, 127, 0.2);
    border-left-color: var(--primary, #5154b3);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  .small-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(127, 127, 127, 0.25);
    border-left-color: var(--primary, #5154b3);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  .error {
    background: var(--error-bg, #ffedea);
    color: var(--error, #ba1a1a);
    padding: 16px;
    border-radius: 8px;
    margin: 16px 0;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  #surfaces {
    padding: var(--bb-grid-size-3, 12px);
    animation: fadeIn 0.35s cubic-bezier(0, 0, 0.3, 1);
    position: relative;
  }
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .surface-wrap {
    position: relative;
  }
  .surface-wrap.is-awaiting .a2ui-host {
    pointer-events: none;
  }
  .awaiting-banner {
    position: sticky;
    top: 12px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    margin-bottom: 12px;
    border-radius: 999px;
    background: light-dark(rgba(255, 255, 255, 0.85), rgba(20, 28, 40, 0.85));
    backdrop-filter: blur(8px);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
    color: var(--fg, #1b1b1b);
    font-size: 14px;
    width: fit-content;
    margin-left: auto;
    margin-right: auto;
    animation: fadeIn 0.25s ease-out;
  }
  .awaiting-banner.is-stalled {
    background: light-dark(rgba(255, 245, 230, 0.95), rgba(60, 40, 20, 0.85));
    color: light-dark(#7a4a00, #f6c89f);
  }
  .material-symbols {
    font-family: 'Material Symbols Outlined', sans-serif;
    font-variation-settings: 'FILL' 1;
  }
`;
