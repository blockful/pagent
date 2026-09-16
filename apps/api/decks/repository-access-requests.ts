import { randomUUID } from 'node:crypto';
import * as db from '../db.ts';
import { normalizeEmail } from './domain.ts';
import { DeckDataInvariantError } from './errors.ts';
import { DeckForbiddenError } from './repository-decks.ts';
import { hashOpaqueToken } from './tokens.ts';

export async function requestAccess(
  token: string,
  email: string,
): Promise<{ readonly requestId: string }> {
  const normalizedEmail = normalizeEmail(email);
  const links = await db.database()<
    {
      id: string;
      deck_id: string;
      workspace_id: string;
    }[]
  >`
    select sl.id, sl.deck_id, d.workspace_id
    from share_links sl join decks d on d.id = sl.deck_id
    where sl.token_hash = ${hashOpaqueToken(token)} and sl.revoked_at is null
      and (sl.expires_at is null or sl.expires_at > now()) and d.deleted_at is null
  `;
  const link = links[0];
  if (link === undefined) return { requestId: randomUUID() };
  const rows = await db.database()<{ id: string }[]>`
    insert into access_requests (share_link_id, requested_email)
    values (${link.id}, ${normalizedEmail})
    on conflict (share_link_id, requested_email) do update
      set status = case when access_requests.status = 'approved' then 'approved' else 'pending' end,
          decided_by = case when access_requests.status = 'approved' then access_requests.decided_by else null end,
          decided_at = case when access_requests.status = 'approved' then access_requests.decided_at else null end
    returning id
  `;
  const requestId = rows[0]?.id;
  if (requestId === undefined) {
    throw new DeckDataInvariantError('access request insert returned no id');
  }
  await db.database()`
    insert into audit_log (workspace_id, deck_id, share_link_id, action, details)
    values (
      ${link.workspace_id}, ${link.deck_id}, ${link.id}, 'viewer.access_requested',
      ${JSON.stringify({ requestedEmail: normalizedEmail })}::jsonb
    )
  `;
  return { requestId };
}

type AccessDecisionInput = {
  readonly userId: string;
  readonly linkId: string;
  readonly requestId: string;
  readonly decision: 'approved' | 'denied';
};

export async function decideAccessRequest(input: AccessDecisionInput): Promise<void> {
  const { userId, linkId, requestId, decision } = input;
  await db.database().begin(async (tx) => {
    const rows = await tx<{ deck_id: string; workspace_id: string }[]>`
      update access_requests ar
      set status = ${decision}, decided_by = ${userId}, decided_at = now()
      from share_links sl, decks d
      where ar.id = ${requestId} and ar.share_link_id = ${linkId}
        and sl.id = ar.share_link_id and d.id = sl.deck_id and d.deleted_at is null
        and (d.owner_id = ${userId} or sl.creator_id = ${userId})
      returning d.id as deck_id, d.workspace_id
    `;
    const row = rows[0];
    if (row === undefined) throw new DeckForbiddenError(linkId);
    await tx`
      insert into audit_log (workspace_id, deck_id, share_link_id, actor_user_id, action, details)
      values (
        ${row.workspace_id}, ${row.deck_id}, ${linkId}, ${userId}, 'viewer.access_decided',
        ${JSON.stringify({ decision, requestId })}::jsonb
      )
    `;
  });
}

export async function getAccessRequestStatus(
  token: string,
  requestId: string,
): Promise<'pending' | 'approved' | 'denied'> {
  const rows = await db.database()<{ status: 'pending' | 'approved' | 'denied' }[]>`
    select ar.status from access_requests ar
    join share_links sl on sl.id = ar.share_link_id
    where ar.id = ${requestId} and sl.token_hash = ${hashOpaqueToken(token)}
  `;
  return rows[0]?.status ?? 'pending';
}
