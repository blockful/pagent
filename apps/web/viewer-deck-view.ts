import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderViewerGate, type ViewerState } from './viewer-gate.ts';
import { confidenceLabel, type ShareMetadata, type ViewerDeck } from './viewer-types.ts';

type DeckViewerViewInput = {
  readonly state: ViewerState;
  readonly metadata: ShareMetadata | null;
  readonly deck: ViewerDeck | null;
  readonly message: string | null;
  readonly slideIndex: number;
  readonly consent: boolean;
  readonly submitting: boolean;
  readonly loginHref: string;
  readonly onCheckRequest: () => void;
  readonly onRequestAccess: () => void;
  readonly onRequestApproval: (event: Event) => void;
  readonly onSubmitEmail: (event: Event) => void;
  readonly onConsentChange: (event: Event) => void;
  readonly onActivity: () => void;
  readonly onFullscreen: () => void;
  readonly onNavigate: (delta: number) => void;
};

export function renderDeckViewer(input: DeckViewerViewInput): TemplateResult {
  if (input.state !== 'ready')
    return html`<div class="shell">
      <main class="page">
        <section class="surface empty" aria-live="polite">
          ${renderViewerGate({
            state: input.state,
            metadata: input.metadata,
            message: input.message,
            consent: input.consent,
            submitting: input.submitting,
            loginHref: input.loginHref,
            onCheckRequest: input.onCheckRequest,
            onRequestAccess: input.onRequestAccess,
            onRequestApproval: input.onRequestApproval,
            onSubmitEmail: input.onSubmitEmail,
            onConsentChange: input.onConsentChange,
          })}
        </section>
      </main>
    </div>`;
  const slide = input.deck?.slides[input.slideIndex];
  return html`<div
    class="viewer-shell"
    @pointerdown=${input.onActivity}
    @touchstart=${input.onActivity}
  >
    <header class="viewer-bar">
      <div>
        <strong>${input.deck?.deckTitle}</strong><br /><span
          class=${`badge ${input.deck?.identityConfidence}`}
          >${input.deck?.preview
            ? 'Owner preview · not tracked'
            : confidenceLabel(input.deck?.identityConfidence)}</span
        >
      </div>
      <button class="button quiet" @click=${input.onFullscreen}>Fullscreen</button>
    </header>
    <main class="viewer-stage">
      <div class="slide-canvas">${slide === undefined ? nothing : unsafeHTML(slide.html)}</div>
    </main>
    <footer class="viewer-controls">
      <button
        class="button secondary"
        ?disabled=${input.slideIndex === 0}
        @click=${() => input.onNavigate(-1)}
      >
        ← Previous</button
      ><span class="mono" role="status" aria-live="polite"
        >Slide ${input.slideIndex + 1} of ${input.deck?.slides.length ?? 0}</span
      ><button
        class="button secondary"
        ?disabled=${input.slideIndex + 1 >= (input.deck?.slides.length ?? 0)}
        @click=${() => input.onNavigate(1)}
      >
        Next →
      </button>
    </footer>
  </div>`;
}
