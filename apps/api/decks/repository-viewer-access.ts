import * as db from '../db.ts';
import {
  matchesAudience,
  normalizeAudience,
  normalizeEmail,
  type IdentityConfidence,
} from './domain.ts';
import { DeckDataInvariantError, ShareUnavailableError, type UnavailableState } from './errors.ts';
import { createOpaqueToken, hashOpaqueToken } from './tokens.ts';

type AuthenticatedViewer = {
  readonly id: string;
  readonly email: string;
};

type ViewerAccessInput = {
  readonly token: string;
  readonly email?: string;
  readonly authenticatedUser?: AuthenticatedViewer;
};

export type ViewerAccessResult =
  | {
      readonly kind: 'granted';
      readonly sessionToken: string;
      readonly identityConfidence: IdentityConfidence;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'email_required' }
  | { readonly kind: 'authentication_required' }
  | { readonly kind: 'unavailable'; readonly canRequest: true };

type AccessLinkRow = {
  readonly id: string;
  readonly deck_id: string;
  readonly workspace_id: string;
  readonly access_mode: 'anyone' | 'allowed_email' | 'authenticated';
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly deleted_at: Date | null;
  readonly allowed_emails: string[];
  readonly allowed_domains: string[];
};

async function loadAccessLink(token: string): Promise<AccessLinkRow> {
  const rows = await db.database()<AccessLinkRow[]>`
    select sl.id, sl.deck_id, d.workspace_id, sl.access_mode, sl.expires_at,
      sl.revoked_at, d.deleted_at,
      coalesce(array_agg(a.audience_value) filter (where a.audience_type = 'email'), '{}') as allowed_emails,
      coalesce(array_agg(a.audience_value) filter (where a.audience_type = 'domain'), '{}') as allowed_domains
    from share_links sl
    join decks d on d.id = sl.deck_id
    left join share_link_audience a on a.share_link_id = sl.id
    where sl.token_hash = ${hashOpaqueToken(token)}
    group by sl.id, d.id
  `;
  const link = rows[0];
  if (link === undefined) throw new ShareUnavailableError('not_found');
  if (link.deleted_at !== null) throw new ShareUnavailableError('deleted');
  if (link.revoked_at !== null) throw new ShareUnavailableError('revoked');
  if (link.expires_at !== null && link.expires_at.getTime() <= Date.now()) {
    throw new ShareUnavailableError('expired');
  }
  return link;
}

async function isApproved(linkId: string, email: string): Promise<boolean> {
  const rows = await db.database()<{ approved: boolean }[]>`
    select exists (
      select 1 from access_requests
      where share_link_id = ${linkId} and requested_email = ${normalizeEmail(email)}
        and status = 'approved'
    ) as approved
  `;
  return rows[0]?.approved ?? false;
}

export async function grantViewerAccess(input: ViewerAccessInput): Promise<ViewerAccessResult> {
  const link = await loadAccessLink(input.token);
  let confidence: IdentityConfidence;
  let viewerEmail: string | null;
  let viewerUserId: string | null;
  switch (link.access_mode) {
    case 'anyone':
      confidence = 'anonymous';
      viewerEmail = null;
      viewerUserId = null;
      break;
    case 'allowed_email': {
      if (input.email === undefined) return { kind: 'email_required' };
      const email = normalizeEmail(input.email);
      const audience = normalizeAudience({
        emails: link.allowed_emails,
        domains: link.allowed_domains,
      });
      if (!matchesAudience(email, audience) && !(await isApproved(link.id, email))) {
        return { kind: 'unavailable', canRequest: true };
      }
      confidence = 'unverified';
      viewerEmail = email;
      viewerUserId = null;
      break;
    }
    case 'authenticated': {
      if (input.authenticatedUser === undefined) return { kind: 'authentication_required' };
      const email = normalizeEmail(input.authenticatedUser.email);
      const audience = normalizeAudience({
        emails: link.allowed_emails,
        domains: link.allowed_domains,
      });
      if (!matchesAudience(email, audience) && !(await isApproved(link.id, email))) {
        return { kind: 'unavailable', canRequest: true };
      }
      confidence = 'authenticated';
      viewerEmail = email;
      viewerUserId = input.authenticatedUser.id;
      break;
    }
    default:
      return assertNever(link.access_mode);
  }
  const sessionToken = createOpaqueToken();
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const expiresAt =
    link.expires_at === null || link.expires_at > sevenDaysFromNow
      ? sevenDaysFromNow
      : link.expires_at;
  await db.database().begin(async (tx) => {
    const sessions = await tx<{ id: string }[]>`
      insert into viewer_sessions (
        share_link_id, token_hash, viewer_user_id, viewer_email,
        identity_confidence, expires_at
      ) values (
        ${link.id}, ${hashOpaqueToken(sessionToken)}, ${viewerUserId}, ${viewerEmail},
        ${confidence}, ${expiresAt}
      ) returning id
    `;
    const sessionId = sessions[0]?.id;
    if (sessionId === undefined) {
      throw new DeckDataInvariantError('viewer session insert returned no id');
    }
    await tx`
      insert into audit_log (
        workspace_id, deck_id, share_link_id, actor_viewer_session_id, action, details
      ) values (
        ${link.workspace_id}, ${link.deck_id}, ${link.id}, ${sessionId}, 'viewer.access_granted',
        ${JSON.stringify({ identityConfidence: confidence })}::jsonb
      )
    `;
  });
  return { kind: 'granted', sessionToken, identityConfidence: confidence, expiresAt };
}

export type ViewerDeck = {
  readonly deckId: string;
  readonly deckTitle: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly shareLinkId: string;
  readonly viewerSessionId: string;
  readonly identityConfidence: IdentityConfidence;
  readonly preview: boolean;
  readonly slides: readonly {
    readonly id: string;
    readonly stableSlideId: string;
    readonly ordinal: number;
    readonly title: string | null;
    readonly html: string;
  }[];
};

export class ViewerSessionUnavailableError extends Error {
  readonly name = 'ViewerSessionUnavailableError';
  readonly state: UnavailableState;

  constructor(state: UnavailableState) {
    super(`viewer session is ${state}`);
    this.state = state;
  }
}

export async function getViewerDeck(sessionToken: string): Promise<ViewerDeck> {
  const database = db.database();
  const rows = await database<
    {
      session_id: string;
      share_link_id: string;
      session_expires_at: Date;
      session_revoked_at: Date | null;
      link_expires_at: Date | null;
      link_revoked_at: Date | null;
      deck_id: string;
      deck_title: string;
      deleted_at: Date | null;
      revision_id: string;
      revision_number: number;
      identity_confidence: IdentityConfidence;
      preview: boolean;
    }[]
  >`
    select vs.id as session_id, sl.id as share_link_id,
      vs.expires_at as session_expires_at, vs.revoked_at as session_revoked_at,
      sl.expires_at as link_expires_at, sl.revoked_at as link_revoked_at,
      d.id as deck_id, d.title as deck_title, d.deleted_at,
      r.id as revision_id, r.revision_number, vs.identity_confidence, vs.preview
    from viewer_sessions vs
    join share_links sl on sl.id = vs.share_link_id
    join decks d on d.id = sl.deck_id
    join deck_revisions r
      on r.deck_id = d.id and r.revision_number = d.latest_revision_number
    where vs.token_hash = ${hashOpaqueToken(sessionToken)}
  `;
  const row = rows[0];
  if (row === undefined) throw new ViewerSessionUnavailableError('not_found');
  if (row.deleted_at !== null) throw new ViewerSessionUnavailableError('deleted');
  if (row.session_revoked_at !== null || row.link_revoked_at !== null) {
    throw new ViewerSessionUnavailableError('revoked');
  }
  if (
    row.session_expires_at.getTime() <= Date.now() ||
    (row.link_expires_at !== null && row.link_expires_at.getTime() <= Date.now())
  ) {
    throw new ViewerSessionUnavailableError('expired');
  }
  const slides = await database<
    {
      id: string;
      stable_slide_id: string;
      ordinal: number;
      title: string | null;
      html: string;
    }[]
  >`
    select id, stable_slide_id, ordinal, title, html
    from deck_slides where revision_id = ${row.revision_id} order by ordinal
  `;
  return {
    deckId: row.deck_id,
    deckTitle: row.deck_title,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    shareLinkId: row.share_link_id,
    viewerSessionId: row.session_id,
    identityConfidence: row.identity_confidence,
    preview: row.preview,
    slides: slides.map((slide) => ({
      id: slide.id,
      stableSlideId: slide.stable_slide_id,
      ordinal: slide.ordinal,
      title: slide.title,
      html: slide.html,
    })),
  };
}

function assertNever(value: never): never {
  throw new DeckDataInvariantError(`Unexpected share access mode: ${String(value)}`);
}
