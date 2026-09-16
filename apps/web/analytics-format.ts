import { html, type TemplateResult } from 'lit';

export function metric(label: string, value: string | number): TemplateResult {
  return html`<article class="surface metric">
    <span class="caption">${label}</span><strong>${value}</strong>
  </article>`;
}

export function emptyAnalytics(title: string, detail: string): TemplateResult {
  return html`<section class="surface empty">
    <h2>${title}</h2>
    <p class="muted">${detail}</p>
  </section>`;
}

export function confidenceLabel(value: 'anonymous' | 'unverified' | 'authenticated'): string {
  return value === 'unverified'
    ? 'Unverified'
    : value === 'authenticated'
      ? 'Authenticated'
      : 'Anonymous';
}

export function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function percent(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(
    value,
  );
}

export function dateTime(value: string | null): string {
  return value === null
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      );
}
