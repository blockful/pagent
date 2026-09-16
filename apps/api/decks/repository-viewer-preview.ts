import * as db from '../db.ts';
import { DeckDataInvariantError } from './errors.ts';
import { DeckForbiddenError } from './repository-decks.ts';
import type { ViewerAccessResult } from './repository-viewer-access.ts';
import { createOpaqueToken, hashOpaqueToken } from './tokens.ts';

export async function grantOwnerPreview(
  userId: string,
  linkId: string,
): Promise<ViewerAccessResult> {
  const rows = await db.database()<
    {
      link_id: string;
      deck_id: string;
      workspace_id: string;
      owner_email: string;
      expires_at: Date | null;
    }[]
  >`
    select sl.id as link_id, d.id as deck_id, d.workspace_id,
      owner.email as owner_email, sl.expires_at
    from share_links sl join decks d on d.id = sl.deck_id
    join users owner on owner.id = d.owner_id
    where sl.id = ${linkId} and d.owner_id = ${userId} and d.deleted_at is null
      and sl.revoked_at is null and (sl.expires_at is null or sl.expires_at > now())
  `;
  const link = rows[0];
  if (link === undefined) throw new DeckForbiddenError(linkId);
  const sessionToken = createOpaqueToken();
  const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const expiresAt =
    link.expires_at === null || link.expires_at > sevenDays ? sevenDays : link.expires_at;
  const sessions = await db.database()<{ id: string }[]>`
    insert into viewer_sessions (
      share_link_id, token_hash, viewer_user_id, viewer_email,
      identity_confidence, preview, expires_at
    ) values (
      ${link.link_id}, ${hashOpaqueToken(sessionToken)}, ${userId}, ${link.owner_email},
      'authenticated', true, ${expiresAt}
    ) returning id
  `;
  if (sessions[0]?.id === undefined) {
    throw new DeckDataInvariantError('preview viewer session insert returned no id');
  }
  return {
    kind: 'granted',
    sessionToken,
    identityConfidence: 'authenticated',
    expiresAt,
  };
}
