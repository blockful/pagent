import { LitElement } from 'lit';
import { apiFetch, apiJson, jsonBody } from './deck-api.ts';
import { analyticsSchema, type DeckAnalytics } from './deck-types.ts';
import { renderAnalyticsPanel, type AnalyticsView } from './deck-analytics-view.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

type AnalyticsFilterInput = Readonly<Record<string, string | number>>;

class DeckAnalyticsPanel extends LitElement {
  static properties = {
    analytics: { attribute: false },
    deckId: { type: String },
    view: { type: String },
    result: { state: true },
    filters: { state: true },
    filtering: { state: true },
    error: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare analytics: DeckAnalytics | null;
  declare deckId: string;
  declare view: AnalyticsView;
  declare result: DeckAnalytics | null;
  declare filters: AnalyticsFilterInput;
  declare filtering: boolean;
  declare error: string | null;

  constructor() {
    super();
    this.analytics = null;
    this.deckId = '';
    this.view = 'overview';
    this.result = null;
    this.filters = {};
    this.filtering = false;
    this.error = null;
  }

  render() {
    return renderAnalyticsPanel({
      base: this.analytics,
      current: this.currentAnalytics(),
      view: this.view,
      filtering: this.filtering,
      error: this.error,
      onApply: (event) => void this.applyFilters(event),
      onClear: () => this.clearFilters(),
      onExport: () => void this.exportCsv(),
    });
  }

  private async applyFilters(event: Event): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    this.filters = readFilters(new FormData(event.currentTarget));
    this.filtering = true;
    this.error = null;
    try {
      this.result = await apiJson(
        `/v1/decks/${this.deckId}/analytics/query`,
        analyticsSchema,
        jsonBody(this.filters),
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not filter analytics';
    } finally {
      this.filtering = false;
    }
  }

  private clearFilters(): void {
    this.filters = {};
    this.result = null;
    const form = this.renderRoot.querySelector('form');
    if (form instanceof HTMLFormElement) form.reset();
  }

  private async exportCsv(): Promise<void> {
    this.error = null;
    try {
      const response = await apiFetch(
        `/v1/decks/${this.deckId}/analytics.csv`,
        jsonBody(this.filters),
      );
      const downloadUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `deck-${this.deckId}-analytics.csv`;
      link.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not export analytics';
    }
  }

  private currentAnalytics(): DeckAnalytics | null {
    return this.result ?? this.analytics;
  }
}

function readFilters(data: FormData): AnalyticsFilterInput {
  const fields = ['link_id', 'viewer', 'sender', 'revision'] as const;
  const filters: Record<string, string | number> = {};
  for (const field of fields) {
    const value = data.get(field);
    if (typeof value === 'string' && value.trim() !== '')
      filters[field] = field === 'revision' ? Number(value) : value.trim();
  }
  const from = data.get('from');
  const to = data.get('to');
  if (typeof from === 'string' && from !== '')
    filters.from = new Date(`${from}T00:00:00.000Z`).toISOString();
  if (typeof to === 'string' && to !== '')
    filters.to = new Date(`${to}T23:59:59.999Z`).toISOString();
  return filters;
}

customElements.define('deck-analytics-panel', DeckAnalyticsPanel);
