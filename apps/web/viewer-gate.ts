import { html, nothing, type TemplateResult } from 'lit';
import type { ShareMetadata } from './viewer-types.ts';

export type ViewerState =
  | 'loading'
  | 'gate'
  | 'authentication'
  | 'unavailable'
  | 'pending'
  | 'denied'
  | 'expired'
  | 'revoked'
  | 'deleted'
  | 'error'
  | 'ready';

type GateInput = {
  readonly state: ViewerState;
  readonly metadata: ShareMetadata | null;
  readonly message: string | null;
  readonly consent: boolean;
  readonly submitting: boolean;
  readonly loginHref: string;
  readonly onCheckRequest: () => void;
  readonly onRequestAccess: () => void;
  readonly onRequestApproval: (event: Event) => void;
  readonly onSubmitEmail: (event: Event) => void;
  readonly onConsentChange: (event: Event) => void;
};

export function renderViewerGate(input: GateInput): TemplateResult {
  if (input.state === 'loading')
    return html`<p class="eyebrow">Opening securely</p>
      <h1>${input.metadata?.deckTitle ?? 'Loading page…'}</h1>
      <span class="loading-line" style="width:min(420px,100%)"></span>`;
  if (input.state === 'expired' || input.state === 'revoked' || input.state === 'deleted')
    return html`<p class="eyebrow">${input.state}</p>
      <h1>This sharing link is ${input.state}.</h1>
      <p class="lede">
        Page content is no longer available from this link. Contact the sender for a current link.
      </p>`;
  if (input.state === 'pending')
    return html`<p class="eyebrow">Request pending</p>
      <h1>The sender is reviewing access.</h1>
      <p class="lede">
        No presentation content is shown until they approve this link-specific request.
      </p>
      <button class="button" @click=${input.onCheckRequest}>Check status</button>`;
  if (input.state === 'denied')
    return html`<p class="eyebrow">Access denied</p>
      <h1>The sender did not approve this request.</h1>
      <p class="lede">
        Contact ${input.metadata?.senderEmail ?? 'the sender'} if you believe this was a mistake.
      </p>`;
  if (input.state === 'authentication')
    return html`<p class="eyebrow">Authenticated viewer</p>
      <h1>Sign in to open “${input.metadata?.deckTitle}”.</h1>
      <p class="lede">${input.metadata?.senderEmail} requires proof of an allowed address.</p>
      ${renderNotice(input)}<a class="button" href=${input.loginHref}
        >Sign in with email or Google</a
      >`;
  if (input.state === 'unavailable')
    return html`<p class="eyebrow">Access unavailable</p>
      <h1>Ask the sender for access.</h1>
      <p class="lede">
        For privacy, Pagent does not reveal which addresses or domains are allowed.
      </p>
      <form class="stack" @submit=${input.onRequestApproval}>
        <div class="field">
          <label for="request-email">Email for the request</label
          ><input id="request-email" name="email" type="email" required />
        </div>
        <button class="button" type="submit">Request access</button>
      </form>`;
  if (input.state === 'error')
    return html`<p class="eyebrow">Could not open page</p>
      <h1>Something went wrong.</h1>
      <p class="notice error" role="alert">${input.message}</p>`;
  return html`<p class="eyebrow">Shared by ${input.metadata?.senderEmail}</p>
    <h1>${input.metadata?.deckTitle}</h1>
    <p class="lede">${gateExplanation(input.metadata)}</p>
    ${renderNotice(input)}${input.metadata?.accessMode === 'anyone'
      ? html`<button
          class="button"
          @click=${input.onRequestAccess}
          aria-busy=${String(input.submitting)}
        >
          Open presentation
        </button>`
      : html`<form class="stack" @submit=${input.onSubmitEmail}>
          <div class="field">
            <label for="viewer-email">Allowed email</label
            ><input id="viewer-email" name="email" type="email" autocomplete="email" required />
          </div>
          <button class="button" type="submit" aria-busy=${String(input.submitting)}>
            Continue
          </button>
        </form>`}`;
}

function renderNotice(input: GateInput): TemplateResult {
  return html`<div class="notice">
    <strong>Privacy & analytics.</strong> Pagent records slide engagement only after the
    presentation is visible and you interact. <a href="/privacy">Read the privacy notice</a>.${input
      .metadata?.analyticsConsentRequired
      ? html`<label class="choice"
          ><input type="checkbox" .checked=${input.consent} @change=${input.onConsentChange} /><span
            >I consent to engagement analytics.</span
          ></label
        >`
      : nothing}
  </div>`;
}

function gateExplanation(metadata: ShareMetadata | null): string {
  if (metadata?.accessMode === 'allowed_email')
    return 'Enter a matching address. This does not verify inbox ownership, so the visit is explicitly labeled Unverified.';
  if (metadata?.accessMode === 'authenticated')
    return 'Sign in to prove control of an allowed email before content is served.';
  return 'Anyone with this link can open an anonymous viewer session.';
}
