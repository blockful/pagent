import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { DeckDetail, DeckPreview } from './deck-types.ts';

export type DeckPreviewInput = {
  readonly preview: DeckPreview | null;
  readonly detail: DeckDetail;
  readonly slideIndex: number;
  readonly canManage: boolean;
  readonly renaming: boolean;
  readonly mutationError: string | null;
  readonly onMove: (delta: number) => void;
  readonly onRename: (event: Event) => void;
};

export function renderDeckPreview(input: DeckPreviewInput): TemplateResult {
  const slide = input.preview?.slides[input.slideIndex];
  const slideCount = input.preview?.slides.length ?? 0;
  return html`<div class="detail-grid">
    <div class="stack">
      <div class="slide-stage">
        <div class="slide-canvas">${slide === undefined ? nothing : unsafeHTML(slide.html)}</div>
      </div>
      <div class="actions" aria-label="Preview navigation">
        <button
          class="button secondary"
          type="button"
          ?disabled=${input.slideIndex === 0}
          @click=${() => input.onMove(-1)}
        >
          Previous
        </button>
        <span class="caption"
          >Slide ${slideCount === 0 ? 0 : input.slideIndex + 1} of ${slideCount}</span
        >
        <button
          class="button secondary"
          type="button"
          ?disabled=${input.slideIndex >= slideCount - 1}
          @click=${() => input.onMove(1)}
        >
          Next
        </button>
      </div>
    </div>
    <aside class="stack">
      ${input.canManage
        ? html`<form
            class="surface stack"
            aria-busy=${String(input.renaming)}
            @submit=${input.onRename}
          >
            <h2>Page identity</h2>
            ${input.renaming && input.mutationError
              ? html`<p class="notice error" role="alert">${input.mutationError}</p>`
              : nothing}
            <div class="field">
              <label for="deck-title">Title</label
              ><input
                id="deck-title"
                name="title"
                required
                ?disabled=${input.renaming}
                .value=${input.detail.title}
              />
            </div>
            <button
              class="button secondary"
              type="submit"
              ?disabled=${input.renaming}
              aria-busy=${String(input.renaming)}
            >
              ${input.renaming ? 'Saving title…' : 'Save title'}
            </button>
          </form>`
        : nothing}
      <section class="surface stack">
        <h2>Revision history</h2>
        ${input.detail.revisions.map(
          (revision) =>
            html`<div>
              <strong>Revision ${revision.revisionNumber}</strong><br /><span class="caption"
                >${revision.slideCount} slides · ${revision.createdByEmail} ·
                ${formatDate(revision.createdAt)}</span
              >
            </div>`,
        )}
      </section>
    </aside>
  </div>`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
