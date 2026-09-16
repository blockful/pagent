import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import * as v0_9 from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9'; // registers <a2ui-surface>
import { mountAgentUI } from './agent-ui-bootstrap.js';
import type { PageFormat, PageResponse } from './agent-ui-page.js';
import {
  idleSubmission,
  isSubmissionLocked,
  receivedSubmission,
  renderSubmissionBanner,
  waitingSubmission,
  type SubmissionState,
} from './agent-ui-submission.js';
import { agentUIStyles } from './agent-ui-styles.js';
import { assertCatalogsAllowed } from './spec-guard.js';
import { nextPollDelay, pollTimeoutMessage } from './poll-backoff.js';
import { createSandboxedIframe } from './html-renderer.js';

/** Hard-coded allowlist of catalog URLs the renderer is permitted to use. */
const ALLOWED_CATALOG_IDS = [basicCatalog.id] as const;

const pageId = location.pathname.replace(/^\/+/, '').split('/')[0];

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// Backoff: 2s → 4s → 8s → 16s → 30s (capped). Across the 60s POLL_TIMEOUT_MS
// window, this fires ~6 polls instead of the 30 a fixed 2s cadence would.
const POLL_INITIAL_MS = 2000;
const POLL_MAX_MS = 30_000;
const POLL_BACKOFF_FACTOR = 2;
const POLL_TIMEOUT_MS = 60_000;

class AgentUIApp extends SignalWatcher(LitElement) {
  static properties = {
    status: { state: true },
    error: { state: true },
    submitError: { state: true },
    submissionState: { state: true },
    format: { state: true },
    htmlBody: { state: true },
  };

  static styles = agentUIStyles;

  declare status: 'connecting' | 'live' | 'closed' | 'error';
  declare error: string | null;
  declare submitError: string | null;
  declare submissionState: SubmissionState;
  declare format: PageFormat;
  declare htmlBody: string | null;

  constructor() {
    super();
    this.status = 'connecting';
    this.error = null;
    this.submitError = null;
    this.submissionState = idleSubmission();
    this.format = 'a2ui';
    this.htmlBody = null;
  }

  private processor = new v0_9.MessageProcessor(
    [basicCatalog],
    async (action: v0_9.A2uiClientAction) => {
      if (isSubmissionLocked(this.submissionState)) return; // already submitted — drop duplicate
      // Optimistic lock — the page is single-shot, so prevent further submits
      // and surface the "waiting for the agent" banner immediately.
      this.submissionState = waitingSubmission();
      this.submitError = null;
      try {
        const res = await fetch(`${API_BASE}/${pageId}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: action.name,
            surfaceId: action.surfaceId,
            sourceComponentId: action.sourceComponentId,
            context: action.context ?? {},
            timestamp: new Date().toISOString(),
          }),
        });
        if (!res.ok) {
          console.warn('result POST failed', res.status);
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          this.submitError = body.message ?? 'Submit failed — please try again';
          this.submissionState = idleSubmission();
          return;
        }
        this.startPollingForReceived();
      } catch (err) {
        console.error('result POST error', err);
        this.submitError = 'Submit failed — please check your connection and try again';
        this.submissionState = idleSubmission();
      }
    },
  );

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDeadline = 0;

  connectedCallback() {
    super.connectedCallback();
    if (!pageId) {
      this.status = 'error';
      this.error = 'No page id in URL.';
      return;
    }
    void this.loadPage();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopPolling();
  }

  private async loadPage() {
    try {
      const res = await fetch(`${API_BASE}/${pageId}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 404) {
        this.status = 'error';
        this.error = 'Page not found or expired.';
        return;
      }
      if (!res.ok) {
        this.status = 'error';
        this.error = `Failed to load page (${res.status}).`;
        return;
      }
      const page = (await res.json()) as PageResponse;
      this.format = page.format ?? 'a2ui';

      if (this.format === 'html') {
        // HTML pages are pre-sanitized server-side. We trust the byte-string
        // and wrap it in a sandboxed iframe. The iframe is opaque-origin and
        // JS-free; nothing it does can reach back into this shell.
        //
        // The shell's #app container has a 640px max-width cap (set in
        // index.html for A2UI/landing layouts). HTML pages are meant to fill
        // the full viewport like a normal webpage, so we flip the `is-html`
        // class on #app to clear the cap — same escape hatch the home page
        // uses via `is-home`.
        document.getElementById('app')?.classList.add('is-html');
        this.htmlBody = typeof page.spec === 'string' ? page.spec : '';
        this.status = 'live';
        return;
      }

      // A2UI path (existing behavior).
      this.applySpec(page.spec);
      this.status = 'live';

      // If the user reloaded after submitting, restore the locked state.
      if (page.state === 'submitted') {
        this.submissionState = waitingSubmission();
        this.startPollingForReceived();
      } else if (page.state === 'received') {
        this.submissionState = receivedSubmission();
      }
    } catch (err) {
      console.error('GET page failed', err);
      this.status = 'error';
      this.error = 'Failed to load page.';
    }
  }

  private applySpec(spec: unknown) {
    for (const id of Array.from(this.processor.model.surfacesMap.keys())) {
      this.processor.model.deleteSurface(id);
    }
    try {
      // Defense-in-depth: reject specs that reference catalogs outside the allowlist
      // before handing off to the processor. The processor already throws on unknown
      // catalogIds (outcome A), but this gate fails loudly with a user-visible message.
      assertCatalogsAllowed(spec, ALLOWED_CATALOG_IDS);
      // spec crosses the API trust boundary as unknown; cast to the typed shape so
      // the compiler will catch any future mismatch in A2UI's input contract.
      this.processor.processMessages(spec as v0_9.A2uiMessage[]);
      this.error = null;
    } catch (err) {
      console.error('processMessages failed', err, spec);
      this.error = String(err);
    }
  }

  private startPollingForReceived() {
    this.stopPolling();
    this.pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    this.submissionState = waitingSubmission();

    const tick = async (delay: number) => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      if (Date.now() >= this.pollDeadline) {
        this.submissionState = { kind: 'stalled', message: pollTimeoutMessage() };
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/${pageId}`, {
          headers: { accept: 'application/json' },
        });
        if (res.ok) {
          const page = (await res.json()) as PageResponse;
          if (page.state === 'received') {
            this.submissionState = receivedSubmission();
            return; // stop polling
          }
        }
        // otherwise keep polling (including 404, since the page may have been
        // evicted; we just stop on timeout/disconnect rather than spam errors).
      } catch (err) {
        console.warn('poll GET failed', err);
      }
      if (!this.isConnected || Date.now() >= this.pollDeadline) return;
      const next = nextPollDelay(delay, POLL_BACKOFF_FACTOR, POLL_MAX_MS);
      this.pollTimer = setTimeout(() => tick(next), next);
    };

    this.pollTimer = setTimeout(() => tick(POLL_INITIAL_MS), POLL_INITIAL_MS);
  }

  private stopPolling() {
    if (this.pollTimer != null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  render() {
    if (this.status === 'error') {
      return html`<div class="error">${this.error ?? 'Connection error'}</div>`;
    }
    if (this.status === 'closed') {
      return html`<div class="status">Session ended.</div>`;
    }

    if (this.format === 'html') {
      return this.renderHtml();
    }

    const surfaces = Array.from(this.processor.model.surfacesMap.entries());
    if (surfaces.length === 0) {
      return html`<div class="pending">
        <div class="spinner"></div>
        <div class="status">Loading…</div>
      </div>`;
    }
    const submissionLocked = isSubmissionLocked(this.submissionState);
    return html`<section
      id="surfaces"
      class="surface-wrap ${submissionLocked ? 'is-awaiting' : ''}"
    >
      ${this.submitError
        ? html`<div class="error" role="alert" aria-live="assertive">${this.submitError}</div>`
        : nothing}
      ${renderSubmissionBanner(this.submissionState)}
      <div class="a2ui-host" aria-disabled=${submissionLocked ? 'true' : 'false'}>
        ${repeat(
          surfaces,
          ([id]) => id,
          ([, surface]) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
        )}
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
    </section>`;
  }

  private renderHtml() {
    if (this.htmlBody == null) {
      return html`<div class="pending">
        <div class="spinner"></div>
        <div class="status">Loading…</div>
      </div>`;
    }
    // No chrome wrapper — the iframe itself is the page. Defense-in-depth
    // (sandbox + meta-CSP + server-side sanitize) still applies; the
    // chrome bar was only a visual disclosure and the product call is to
    // render HTML pages exactly as if the user opened the .html file.
    return this.htmlIframe();
  }

  // The Lit literal cannot embed a raw iframe element easily because Lit owns
  // attribute setting and srcdoc would be re-escaped. We construct the iframe
  // imperatively and stash it across renders via this helper.
  private cachedIframe: HTMLIFrameElement | null = null;
  private cachedIframeFor: string | null = null;
  private htmlIframe() {
    if (this.htmlBody == null) return nothing;
    if (this.cachedIframe == null || this.cachedIframeFor !== this.htmlBody) {
      this.cachedIframe = createSandboxedIframe(this.htmlBody);
      this.cachedIframeFor = this.htmlBody;
    }
    return this.cachedIframe;
  }
}

customElements.define('agent-ui-app', AgentUIApp);
mountAgentUI(pageId);
