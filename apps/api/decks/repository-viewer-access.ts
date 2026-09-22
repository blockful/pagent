import * as db from '../db.ts';
import {
  matchesAudience,
  normalizeAudience,
  normalizeEmail,
  type IdentityConfidence,
} from './domain.ts';
import { DeckDataInvariantError, ShareUnavailableError } from './errors.ts';
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
  readonly owner_id: string;
  readonly access_mode: 'anyone' | 'allowed_email' | 'authenticated';
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly deleted_at: Date | null;
  readonly allowed_emails: string[];
  readonly allowed_domains: string[];
};

async function loadAccessLink(token: string): Promise<AccessLinkRow> {
  const rows = await db.database()<AccessLinkRow[]>`
    select sl.id, sl.deck_id, d.workspace_id, d.owner_id, sl.access_mode, sl.expires_at,
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

async function isContentEditor(link: AccessLinkRow, userId: string): Promise<boolean> {
  const rows = await db.database()<{ content_editor: boolean }[]>`
    select exists (
      select 1 from deck_collaborators dc
      join workspace_members wm
        on wm.workspace_id = ${link.workspace_id} and wm.user_id = dc.user_id
      where dc.deck_id = ${link.deck_id} and dc.user_id = ${userId}
        and dc.can_view_content = true and wm.status = 'active'
    ) as content_editor
  `;
  return rows[0]?.content_editor ?? false;
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
  const authenticatedUser = input.authenticatedUser;
  const analyticsExcluded =
    authenticatedUser !== undefined &&
    (authenticatedUser.id === link.owner_id || (await isContentEditor(link, authenticatedUser.id)));
  await db.database().begin(async (tx) => {
    const sessions = await tx<{ id: string }[]>`
      insert into viewer_sessions (
        share_link_id, token_hash, viewer_user_id, viewer_email,
        identity_confidence, analytics_excluded, expires_at
      ) values (
        ${link.id}, ${hashOpaqueToken(sessionToken)}, ${viewerUserId}, ${viewerEmail},
        ${confidence}, ${analyticsExcluded}, ${expiresAt}
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

export {
  getViewerDeck,
  ViewerSessionUnavailableError,
  type ViewerDeck,
} from './repository-viewer-deck.ts';

function assertNever(value: never): never {
  throw new DeckDataInvariantError(`Unexpected share access mode: ${String(value)}`);
}
