import { html, nothing, type TemplateResult } from 'lit';

export type SubmissionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'stalled'; readonly message: string }
  | { readonly kind: 'received' };

export const idleSubmission = (): SubmissionState => ({ kind: 'idle' });
export const waitingSubmission = (): SubmissionState => ({ kind: 'waiting' });
export const receivedSubmission = (): SubmissionState => ({ kind: 'received' });

export function isSubmissionLocked(state: SubmissionState): boolean {
  return state.kind !== 'idle';
}

export function renderSubmissionBanner(state: SubmissionState): TemplateResult | typeof nothing {
  switch (state.kind) {
    case 'idle':
      return nothing;
    case 'waiting':
      return html`<div class="awaiting-banner" role="status" aria-live="polite">
        <div class="small-spinner"></div>
        <span>Sent — waiting for the agent…</span>
      </div>`;
    case 'stalled':
      return html`<div class="awaiting-banner is-stalled" role="status" aria-live="polite">
        <span class="material-symbols" aria-hidden="true">info</span>
        <span>${state.message}</span>
      </div>`;
    case 'received':
      return html`<div class="awaiting-banner" role="status" aria-live="polite">
        <span class="material-symbols" aria-hidden="true">check_circle</span>
        <span>The agent has your input</span>
      </div>`;
  }
}
