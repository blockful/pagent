import { LitElement } from 'lit';
import { apiJson, loginUrl } from './deck-api.ts';
import {
  requestedAccessSchema,
  shareMetadataSchema,
  viewerAccessSchema,
  viewerDeckSchema,
  type ShareMetadata,
  type ViewerDeck,
} from './viewer-types.ts';
import type { ViewerState } from './viewer-gate.ts';
import { renderDeckViewer } from './viewer-deck-view.ts';
import { productLayoutStyles } from './product-layout-styles.ts';
import { productStyles } from './product-styles.ts';
import { productViewerStyles } from './product-viewer-styles.ts';
import { EngagementTracker } from './viewer-tracking.ts';
import { observeViewerStage, toggleFullscreen } from './viewer-interaction.ts';
import {
  accessRequestKey,
  getAccessRequestStatus,
  viewerFailure,
  viewerSessionKey,
} from './viewer-session.ts';

class DeckViewer extends LitElement {
  static properties = {
    shareToken: { type: String },
    metadata: { state: true },
    deck: { state: true },
    state: { state: true },
    message: { state: true },
    slideIndex: { state: true },
    consent: { state: true },
    submitting: { state: true },
  };
  static styles = [productStyles, productLayoutStyles, productViewerStyles];

  declare shareToken: string;
  declare metadata: ShareMetadata | null;
  declare deck: ViewerDeck | null;
  declare state: ViewerState;
  declare message: string | null;
  declare slideIndex: number;
  declare consent: boolean;
  declare submitting: boolean;

  private sessionToken: string | null = null;
  private tracker: EngagementTracker | null = null;
  private observer: IntersectionObserver | null = null;

  constructor() {
    super();
    this.shareToken = '';
    this.metadata = null;
    this.deck = null;
    this.state = 'loading';
    this.message = null;
    this.slideIndex = 0;
    this.consent = false;
    this.submitting = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    void this.load();
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    this.observer?.disconnect();
    this.tracker?.stop();
    super.disconnectedCallback();
  }

  private async load(): Promise<void> {
    if (this.shareToken === '') {
      const preview = sessionStorage.getItem('pagent-owner-preview');
      if (preview === null) {
        this.handleError(new Error('Owner preview session is missing.'));
        return;
      }
      this.sessionToken = preview;
      await this.loadDeck();
      return;
    }
    try {
      this.metadata = await apiJson('/v1/share', shareMetadataSchema, {
        headers: { 'x-share-token': this.shareToken },
      });
      this.consent = !this.metadata.analyticsConsentRequired;
      if (this.metadata.state !== 'active') {
        this.state = this.metadata.state;
        return;
      }
      const saved = sessionStorage.getItem(viewerSessionKey(this.shareToken));
      if (saved !== null) {
        this.sessionToken = saved;
        if (await this.loadDeck(false)) return;
        sessionStorage.removeItem(viewerSessionKey(this.shareToken));
      }
      const requestId = sessionStorage.getItem(accessRequestKey(this.shareToken));
      if (requestId !== null) {
        const status = await getAccessRequestStatus(this.shareToken, requestId);
        if (status !== 'approved') {
          this.state = status;
          return;
        }
      }
      if (this.metadata.accessMode === 'anyone' && !this.metadata.analyticsConsentRequired) {
        await this.requestAccess();
      } else if (this.metadata.accessMode === 'authenticated') {
        await this.requestAccess();
      } else {
        this.state = 'gate';
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private async requestAccess(email?: string): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    try {
      await this.completeAccessRequest(email);
    } catch (error) {
      this.handleError(error);
    } finally {
      this.submitting = false;
    }
  }

  private async submitEmail(event: Event): Promise<void> {
    event.preventDefault();
    if (this.submitting) return;
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const email = new FormData(event.currentTarget).get('email');
    if (typeof email === 'string') await this.requestAccess(email);
  }

  private async requestAccessApproval(event: Event): Promise<void> {
    event.preventDefault();
    if (this.submitting) return;
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const email = new FormData(event.currentTarget).get('email');
    if (typeof email !== 'string') return;
    this.submitting = true;
    try {
      const requested = await apiJson('/v1/share/request', requestedAccessSchema, {
        method: 'POST',
        headers: { 'x-share-token': this.shareToken },
        body: JSON.stringify({ email }),
      });
      sessionStorage.setItem(accessRequestKey(this.shareToken), requested.requestId);
      sessionStorage.setItem(`${accessRequestKey(this.shareToken)}:email`, email);
      this.state = 'pending';
    } catch (error) {
      this.handleError(error);
    } finally {
      this.submitting = false;
    }
  }

  private async checkRequest(): Promise<void> {
    if (this.submitting) return;
    const requestId = sessionStorage.getItem(accessRequestKey(this.shareToken));
    if (requestId === null) return;
    this.submitting = true;
    try {
      const status = await getAccessRequestStatus(this.shareToken, requestId);
      if (status === 'approved') {
        const email =
          sessionStorage.getItem(`${accessRequestKey(this.shareToken)}:email`) ?? undefined;
        await this.completeAccessRequest(email);
      } else this.state = status;
    } catch (error) {
      this.handleError(error);
    } finally {
      this.submitting = false;
    }
  }

  private async completeAccessRequest(email?: string): Promise<void> {
    const access = await apiJson('/v1/share/access', viewerAccessSchema, {
      method: 'POST',
      headers: { 'x-share-token': this.shareToken },
      body: JSON.stringify(email === undefined ? {} : { email }),
    });
    if (access.kind === 'authentication_required') this.state = 'authentication';
    else if (access.kind === 'email_required') this.state = 'gate';
    else if (access.kind === 'unavailable') this.state = 'unavailable';
    else {
      this.sessionToken = access.sessionToken;
      sessionStorage.setItem(viewerSessionKey(this.shareToken), access.sessionToken);
      await this.loadDeck();
    }
  }

  private async loadDeck(report = true): Promise<boolean> {
    if (this.sessionToken === null) return false;
    try {
      this.deck = await apiJson('/v1/viewer/deck', viewerDeckSchema, {
        headers: { 'x-viewer-session': this.sessionToken },
      });
      this.state = 'ready';
      await this.updateComplete;
      this.startTracking();
      return true;
    } catch (error) {
      if (report) this.handleError(error);
      return false;
    }
  }

  private startTracking(): void {
    if (this.sessionToken === null || this.deck === null) return;
    this.tracker?.stop();
    const tracker = new EngagementTracker({
      sessionToken: this.sessionToken,
      currentSlideId: () => this.deck?.slides[this.slideIndex]?.id ?? null,
      analyticsConsent: this.consent,
    });
    this.tracker = tracker;
    this.observer?.disconnect();
    this.observer = observeViewerStage({ root: this.renderRoot, tracker });
  }

  private navigate(delta: number): void {
    if (this.deck === null) return;
    this.slideIndex = Math.max(0, Math.min(this.deck.slides.length - 1, this.slideIndex + delta));
    const slideId = this.deck.slides[this.slideIndex]?.id;
    if (slideId !== undefined) this.tracker?.recordSlide(slideId);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    this.tracker?.markActivity();
    if (event.key === 'ArrowRight' || event.key === 'PageDown') this.navigate(1);
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') this.navigate(-1);
    else if (event.key === 'Home') this.navigate(-this.slideIndex);
    else if (event.key === 'End' && this.deck !== null) this.navigate(this.deck.slides.length);
    else return;
    event.preventDefault();
  };

  private onPageHide = (): void => this.tracker?.close();
  private onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.startTracking();
  };
  private onFocus = (): void => this.tracker?.markActivity();
  private handleError(error: unknown): void {
    const failure = viewerFailure(error);
    this.state = failure.state;
    this.message = failure.message;
    if (failure.state === 'error') {
      void this.updateComplete.then(() => {
        this.renderRoot.querySelector<HTMLElement>('[role="alert"]')?.focus();
      });
    }
  }

  render() {
    return renderDeckViewer({
      state: this.state,
      metadata: this.metadata,
      deck: this.deck,
      message: this.message,
      slideIndex: this.slideIndex,
      consent: this.consent,
      submitting: this.submitting,
      loginHref: loginUrl(location.pathname),
      onCheckRequest: () => void this.checkRequest(),
      onRequestAccess: () => void this.requestAccess(),
      onRequestApproval: (event) => void this.requestAccessApproval(event),
      onSubmitEmail: (event) => void this.submitEmail(event),
      onConsentChange: (event) => {
        if (event.currentTarget instanceof HTMLInputElement)
          this.consent = event.currentTarget.checked;
      },
      onActivity: () => this.tracker?.markActivity(),
      onFullscreen: () => void toggleFullscreen(this),
      onNavigate: (delta) => this.navigate(delta),
    });
  }
}

customElements.define('deck-viewer', DeckViewer);
