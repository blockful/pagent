import * as db from '../db.ts';
import type { CreateShareLinkBody } from './domain.ts';
import { normalizeAudience } from './domain.ts';
import { DeckDataInvariantError, ShareUnavailableError } from './errors.ts';
import { DeckForbiddenError } from './repository-decks.ts';
import { createOpaqueToken, hashOpaqueToken } from './tokens.ts';

export type CreatedShareLink = {
  readonly id: string;
  readonly token: string;
  readonly accessMode: 'anyone' | 'allowed_email' | 'authenticated';
  readonly expiresAt: Date | null;
};

export async function createShareLink(
  userId: string,
  deckId: string,
  input: CreateShareLinkBody,
): Promise<CreatedShareLink> {
  const expiresAt = input.expires_at === undefined ? null : new Date(input.expires_at);
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw new RangeError('share-link expiry must be in the future');
  }
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token);
  return db.database().begin(async (tx) => {
    const decks = await tx<{ workspace_id: string }[]>`
      select workspace_id from decks
      where id = ${deckId} and owner_id = ${userId} and deleted_at is null
      for update
    `;
    const workspaceId = decks[0]?.workspace_id;
    if (workspaceId === undefined) throw new DeckForbiddenError(deckId);
    const links = await tx<{ id: string }[]>`
      insert into share_links (deck_id, creator_id, name, token_hash, access_mode, expires_at)
      values (${deckId}, ${userId}, ${input.name}, ${tokenHash}, ${input.access_mode}, ${expiresAt})
      returning id
    `;
    const linkId = links[0]?.id;
    if (linkId === undefined) {
      throw new DeckDataInvariantError('share link insert returned no id');
    }
    const audience = normalizeAudience({
      emails: input.allowed_emails,
      domains: input.allowed_domains,
    });
    for (const email of audience.emails) {
      await tx`
        insert into share_link_audience (share_link_id, audience_type, audience_value)
        values (${linkId}, 'email', ${email})
      `;
    }
    for (const domain of audience.domains) {
      await tx`
        insert into share_link_audience (share_link_id, audience_type, audience_value)
        values (${linkId}, 'domain', ${domain})
      `;
    }
    await tx`
      insert into audit_log (workspace_id, deck_id, share_link_id, actor_user_id, action, details)
      values (
        ${workspaceId}, ${deckId}, ${linkId}, ${userId}, 'share_link.created',
        ${JSON.stringify({ accessMode: input.access_mode, name: input.name })}::jsonb
      )
    `;
    return { id: linkId, token, accessMode: input.access_mode, expiresAt };
  });
}

export type ShareMetadata = {
  readonly linkId: string;
  readonly linkName: string;
  readonly deckTitle: string;
  readonly senderEmail: string;
  readonly accessMode: 'anyone' | 'allowed_email' | 'authenticated';
  readonly state: 'active' | 'expired' | 'revoked' | 'deleted';
  readonly analyticsConsentRequired: boolean;
};

export async function getShareMetadata(token: string): Promise<ShareMetadata> {
  const rows = await db.database()<
    {
      link_id: string;
      link_name: string;
      deck_title: string;
      sender_email: string;
      access_mode: 'anyone' | 'allowed_email' | 'authenticated';
      expires_at: Date | null;
      revoked_at: Date | null;
      deleted_at: Date | null;
      analytics_consent_required: boolean;
    }[]
  >`
    select sl.id as link_id, sl.name as link_name, d.title as deck_title,
      u.email as sender_email, sl.access_mode, sl.expires_at, sl.revoked_at,
      d.deleted_at, w.analytics_consent_required
    from share_links sl
    join decks d on d.id = sl.deck_id
    join users u on u.id = sl.creator_id
    join workspaces w on w.id = d.workspace_id
    where sl.token_hash = ${hashOpaqueToken(token)}
  `;
  const row = rows[0];
  if (row === undefined) throw new ShareUnavailableError('not_found');
  const state = shareState(row);
  return {
    linkId: row.link_id,
    linkName: row.link_name,
    deckTitle: row.deck_title,
    senderEmail: row.sender_email,
    accessMode: row.access_mode,
    state,
    analyticsConsentRequired: row.analytics_consent_required,
  };
}

type ShareStateInput = {
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly deleted_at: Date | null;
};

function shareState(input: ShareStateInput): ShareMetadata['state'] {
  if (input.deleted_at !== null) return 'deleted';
  if (input.revoked_at !== null) return 'revoked';
  if (input.expires_at !== null && input.expires_at.getTime() <= Date.now()) return 'expired';
  return 'active';
}

export async function revokeShareLink(
  userId: string,
  deckId: string,
  linkId: string,
): Promise<void> {
  await db.database().begin(async (tx) => {
    const rows = await tx<{ workspace_id: string }[]>`
      update share_links sl set revoked_at = now(), updated_at = now()
      from decks d
      where sl.id = ${linkId} and sl.deck_id = ${deckId} and d.id = sl.deck_id
        and d.deleted_at is null and (
          d.owner_id = ${userId}
          or sl.creator_id = ${userId} and exists (
            select 1 from workspace_members wm
            where wm.workspace_id = d.workspace_id and wm.user_id = ${userId}
              and wm.status = 'active'
          )
        )
      returning d.workspace_id
    `;
    const workspaceId = rows[0]?.workspace_id;
    if (workspaceId === undefined) throw new DeckForbiddenError(deckId);
    await tx`
      update viewer_sessions set revoked_at = now()
      where share_link_id = ${linkId} and revoked_at is null
    `;
    await tx`
      insert into audit_log (workspace_id, deck_id, share_link_id, actor_user_id, action)
      values (${workspaceId}, ${deckId}, ${linkId}, ${userId}, 'share_link.revoked')
    `;
  });
}

export {
  decideAccessRequest,
  getAccessRequestStatus,
  requestAccess,
} from './repository-access-requests.ts';
export { getViewerDeck, grantViewerAccess } from './repository-viewer-access.ts';
export { ShareUnavailableError } from './errors.ts';
