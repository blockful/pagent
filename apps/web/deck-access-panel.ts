import { LitElement } from 'lit';
import { apiEmpty, apiJson } from './deck-api.ts';
import { renderAccessPanel } from './deck-access-view.ts';
import {
  accessSettingsSchema,
  analyticsAudienceSchema,
  auditLogSchema,
  type AccessSettings,
  type AnalyticsAudience,
  type AuditEvent,
} from './deck-types.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';

type Visibility = AccessSettings['analyticsVisibility'];

class DeckAccessPanel extends LitElement {
  static properties = {
    deckId: { type: String },
    settings: { state: true },
    audit: { state: true },
    visibility: { state: true },
    subjectIds: { state: true },
    contentIds: { state: true },
    audience: { state: true },
    loading: { state: true },
    error: { state: true },
    message: { state: true },
  };
  static styles = [productStyles, productLayoutStyles];

  declare deckId: string;
  declare settings: AccessSettings | null;
  declare audit: readonly AuditEvent[];
  declare visibility: Visibility;
  declare subjectIds: readonly string[];
  declare contentIds: readonly string[];
  declare audience: AnalyticsAudience | null;
  declare loading: boolean;
  declare error: string | null;
  declare message: string | null;

  constructor() {
    super();
    this.deckId = '';
    this.settings = null;
    this.audit = [];
    this.visibility = 'private';
    this.subjectIds = [];
    this.contentIds = [];
    this.audience = null;
    this.loading = true;
    this.error = null;
    this.message = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const [settings, audit] = await Promise.all([
        apiJson(`/v1/decks/${this.deckId}/access`, accessSettingsSchema),
        apiJson(`/v1/decks/${this.deckId}/audit`, auditLogSchema),
      ]);
      this.settings = settings;
      this.audit = audit.events;
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
    this.audience = await apiJson(
      `/v1/decks/${this.deckId}/access/analytics/preview`,
      analyticsAudienceSchema,
      {
        method: 'POST',
        body: JSON.stringify({ scope: this.visibility, subjectIds: this.subjectIds }),
      },
    );
  }

  private async saveAudience(): Promise<void> {
    await apiJson(`/v1/decks/${this.deckId}/access/analytics`, analyticsAudienceSchema, {
      method: 'PUT',
      body: JSON.stringify({ scope: this.visibility, subjectIds: this.subjectIds }),
    });
    this.message = 'Analytics audience updated immediately.';
    await this.load();
  }

  private async saveContent(): Promise<void> {
    await apiEmpty(`/v1/decks/${this.deckId}/access/collaborators`, {
      method: 'PUT',
      body: JSON.stringify({ memberIds: this.contentIds }),
    });
    this.message = 'Deck content collaborators updated.';
    await this.load();
  }

  private async addMember(event: Event): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const data = new FormData(event.currentTarget);
    await apiJson(`/v1/decks/${this.deckId}/access/members`, memberSchema, {
      method: 'POST',
      body: JSON.stringify({ email: field(data, 'email'), role: field(data, 'role') }),
    });
    event.currentTarget.reset();
    this.message = 'Workspace member added.';
    await this.load();
  }

  private async removeMember(memberId: string, email: string): Promise<void> {
    if (
      !window.confirm(
        `Remove ${email} from this workspace? Their deck and analytics access ends immediately.`,
      )
    )
      return;
    await apiEmpty(`/v1/decks/${this.deckId}/access/members/${memberId}`, { method: 'DELETE' });
    this.message = 'Member access removed immediately.';
    await this.load();
  }

  private async savePolicy(event: Event): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const data = new FormData(event.currentTarget);
    await apiEmpty(`/v1/decks/${this.deckId}/access/policy`, {
      method: 'PUT',
      body: JSON.stringify({
        consentRequired: data.get('consent') === 'on',
        retentionDays: Number(field(data, 'retention')),
      }),
    });
    this.message = 'Privacy and retention policy saved.';
    await this.load();
  }

  render() {
    return renderAccessPanel({
      settings: this.settings,
      audit: this.audit,
      visibility: this.visibility,
      subjectIds: this.subjectIds,
      contentIds: this.contentIds,
      audience: this.audience,
      loading: this.loading,
      error: this.error,
      message: this.message,
      onVisibilityChange: (event) => this.changeVisibility(event),
      onToggleSubject: (event) => this.toggleSubject(event),
      onToggleContent: (event) => this.toggleContent(event),
      onPreviewAudience: () => void this.previewAudience(),
      onSaveAudience: () => void this.saveAudience(),
      onSaveContent: () => void this.saveContent(),
      onAddMember: (event) => void this.addMember(event),
      onRemoveMember: (memberId, email) => void this.removeMember(memberId, email),
      onSavePolicy: (event) => void this.savePolicy(event),
    });
  }
}

const memberSchema = accessSettingsSchema.shape.members.element.pick({
  id: true,
  email: true,
  handle: true,
});
function toggle(values: readonly string[], id: string, checked: boolean): readonly string[] {
  return checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);
}
function field(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value.trim() : '';
}
customElements.define('deck-access-panel', DeckAccessPanel);
