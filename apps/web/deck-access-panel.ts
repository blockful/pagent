import { LitElement } from 'lit';
import { apiEmpty, apiJson } from './deck-api.ts';
import { renderAccessPanel } from './deck-access-view.ts';
import {
  accessSettingsSchema,
  analyticsAudienceSchema,
  type AccessSettings,
  type AnalyticsAudience,
} from './deck-types.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

type Visibility = AccessSettings['analyticsVisibility'];

class DeckAccessPanel extends LitElement {
  static properties = {
    deckId: { type: String },
    settings: { state: true },
    visibility: { state: true },
    subjectIds: { state: true },
    contentIds: { state: true },
    audience: { state: true },
    loading: { state: true },
    saving: { state: true },
    error: { state: true },
    message: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare deckId: string;
  declare settings: AccessSettings | null;
  declare visibility: Visibility;
  declare subjectIds: readonly string[];
  declare contentIds: readonly string[];
  declare audience: AnalyticsAudience | null;
  declare loading: boolean;
  declare saving: 'audience' | 'content' | 'preview' | null;
  declare error: string | null;
  declare message: string | null;

  constructor() {
    super();
    this.deckId = '';
    this.settings = null;
    this.visibility = 'private';
    this.subjectIds = [];
    this.contentIds = [];
    this.audience = null;
    this.loading = true;
    this.saving = null;
    this.error = null;
    this.message = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const settings = await apiJson(`/v1/decks/${this.deckId}/access`, accessSettingsSchema);
      this.settings = settings;
      this.visibility = settings.analyticsVisibility;
      this.contentIds = settings.members
        .filter((member) => member.canViewContent)
        .map((member) => member.id);
      this.subjectIds =
        this.visibility === 'team'
          ? settings.teams.filter((team) => team.selectedForAnalytics).map((team) => team.id)
          : settings.members
              .filter((member) => member.selectedForAnalytics)
              .map((member) => member.id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not load access settings';
    } finally {
      this.loading = false;
    }
  }

  private changeVisibility(event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    const value = event.currentTarget.value;
    if (value === 'private' || value === 'selected' || value === 'team' || value === 'workspace') {
      this.visibility = value;
      this.subjectIds = [];
      this.audience = null;
    }
  }

  private toggleSubject(event: Event): void {
    if (!(event.currentTarget instanceof HTMLInputElement)) return;
    this.subjectIds = toggle(
      this.subjectIds,
      event.currentTarget.value,
      event.currentTarget.checked,
    );
    this.audience = null;
  }

  private toggleContent(event: Event): void {
    if (!(event.currentTarget instanceof HTMLInputElement)) return;
    this.contentIds = toggle(
      this.contentIds,
      event.currentTarget.value,
      event.currentTarget.checked,
    );
  }

  private async previewAudience(): Promise<void> {
    await this.runMutation(
      'preview',
      async () => {
        this.audience = await apiJson(
          `/v1/decks/${this.deckId}/access/analytics/preview`,
          analyticsAudienceSchema,
          {
            method: 'POST',
            body: JSON.stringify({ scope: this.visibility, subjectIds: this.subjectIds }),
          },
        );
      },
      'Audience preview ready.',
      false,
    );
  }

  private async saveAudience(): Promise<void> {
    await this.runMutation(
      'audience',
      async () => {
        await apiJson(`/v1/decks/${this.deckId}/access/analytics`, analyticsAudienceSchema, {
          method: 'PUT',
          body: JSON.stringify({ scope: this.visibility, subjectIds: this.subjectIds }),
        });
      },
      'Analytics audience updated immediately.',
      true,
    );
  }

  private async saveContent(): Promise<void> {
    await this.runMutation(
      'content',
      async () => {
        await apiEmpty(`/v1/decks/${this.deckId}/access/collaborators`, {
          method: 'PUT',
          body: JSON.stringify({ memberIds: this.contentIds }),
        });
      },
      'Page content collaborators updated.',
      true,
    );
  }

  private async runMutation(
    saving: 'audience' | 'content' | 'preview',
    mutation: () => Promise<void>,
    success: string,
    reload: boolean,
  ): Promise<void> {
    this.saving = saving;
    this.error = null;
    this.message = null;
    try {
      await mutation();
      this.message = success;
      if (reload) await this.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not save page permissions';
    } finally {
      this.saving = null;
    }
  }

  render() {
    return renderAccessPanel({
      settings: this.settings,
      visibility: this.visibility,
      subjectIds: this.subjectIds,
      contentIds: this.contentIds,
      audience: this.audience,
      loading: this.loading,
      saving: this.saving,
      error: this.error,
      message: this.message,
      onVisibilityChange: (event) => this.changeVisibility(event),
      onToggleSubject: (event) => this.toggleSubject(event),
      onToggleContent: (event) => this.toggleContent(event),
      onPreviewAudience: () => void this.previewAudience(),
      onSaveAudience: () => void this.saveAudience(),
      onSaveContent: () => void this.saveContent(),
    });
  }
}

function toggle(values: readonly string[], id: string, checked: boolean): readonly string[] {
  return checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);
}
customElements.define('deck-access-panel', DeckAccessPanel);
