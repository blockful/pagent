import * as db from '../db.ts';
import type { CreateShareLinkBody } from './domain.ts';
import { normalizeAudience } from './domain.ts';
import { DeckForbiddenError } from './repository-decks.ts';

export type ShareLinkSummary = {
  readonly id: string;
  readonly name: string;
  readonly creatorId: string;
  readonly creatorEmail: string;
  readonly accessMode: 'anyone' | 'allowed_email' | 'authenticated';
  readonly allowedEmails: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly visitCount: number;
  readonly createdAt: Date;
};

export type AccessRequestSummary = {
  readonly id: string;
  readonly requestedEmail: string;
  readonly status: 'pending' | 'approved' | 'denied';
  readonly createdAt: Date;
};

export async function listShareLinks(
  userId: string,
  deckId: string,
): Promise<readonly ShareLinkSummary[]> {
  const rows = await db.database()<
    {
      id: string;
      name: string;
      creator_id: string;
      creator_email: string;
      access_mode: 'anyone' | 'allowed_email' | 'authenticated';
      allowed_emails: string[];
      allowed_domains: string[];
      expires_at: Date | null;
      revoked_at: Date | null;
      visit_count: string;
      created_at: Date;
    }[]
  >`
    select sl.id, sl.name, sl.creator_id, creator.email as creator_email,
      sl.access_mode, sl.expires_at, sl.revoked_at, sl.created_at,
      coalesce(array_agg(a.audience_value) filter (where a.audience_type = 'email'), '{}') as allowed_emails,
      coalesce(array_agg(a.audience_value) filter (where a.audience_type = 'domain'), '{}') as allowed_domains,
      (select count(*) from visits v where v.share_link_id = sl.id and v.excluded = false)::text as visit_count
    from share_links sl
    join decks d on d.id = sl.deck_id
    join users creator on creator.id = sl.creator_id
    left join share_link_audience a on a.share_link_id = sl.id
    where sl.deck_id = ${deckId} and d.deleted_at is null and (
      d.owner_id = ${userId} or sl.creator_id = ${userId} and exists (
        select 1 from workspace_members wm
        where wm.workspace_id = d.workspace_id and wm.user_id = ${userId} and wm.status = 'active'
      )
    )
    group by sl.id, creator.email order by sl.created_at desc
  `;
  if (rows.length === 0) {
    const allowed = await db.database()<{ allowed: boolean }[]>`
      select exists (
        select 1 from decks d where d.id = ${deckId} and d.deleted_at is null and d.owner_id = ${userId}
      ) as allowed
    `;
    if (!(allowed[0]?.allowed ?? false)) throw new DeckForbiddenError(deckId);
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    creatorId: row.creator_id,
    creatorEmail: row.creator_email,
    accessMode: row.access_mode,
    allowedEmails: row.allowed_emails,
    allowedDomains: row.allowed_domains,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    visitCount: Number(row.visit_count),
    createdAt: row.created_at,
  }));
}

type ShareLinkUpdateInput = {
  readonly userId: string;
  readonly deckId: string;
  readonly linkId: string;
  readonly body: CreateShareLinkBody;
};

export async function updateShareLink(input: ShareLinkUpdateInput): Promise<void> {
  const { userId, deckId, linkId, body } = input;
  const expiresAt = body.expires_at === undefined ? null : new Date(body.expires_at);
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw new RangeError('share-link expiry must be in the future');
  }
  const audience = normalizeAudience({
    emails: body.allowed_emails,
    domains: body.allowed_domains,
  });
  await db.database().begin(async (tx) => {
    const rows = await tx<{ workspace_id: string }[]>`
      update share_links sl set name = ${body.name}, access_mode = ${body.access_mode},
        expires_at = ${expiresAt}, updated_at = now()
      from decks d where sl.id = ${linkId} and sl.deck_id = ${deckId} and d.id = sl.deck_id
        and d.deleted_at is null and (d.owner_id = ${userId} or sl.creator_id = ${userId} and exists (
          select 1 from workspace_members wm where wm.workspace_id = d.workspace_id
            and wm.user_id = ${userId} and wm.status = 'active'
        )) returning d.workspace_id
    `;
    const workspaceId = rows[0]?.workspace_id;
    if (workspaceId === undefined) throw new DeckForbiddenError(deckId);
    await tx`delete from share_link_audience where share_link_id = ${linkId}`;
    for (const email of audience.emails) {
      await tx`insert into share_link_audience (share_link_id, audience_type, audience_value) values (${linkId}, 'email', ${email})`;
    }
    for (const domain of audience.domains) {
      await tx`insert into share_link_audience (share_link_id, audience_type, audience_value) values (${linkId}, 'domain', ${domain})`;
    }
    await tx`update viewer_sessions set revoked_at = now() where share_link_id = ${linkId} and revoked_at is null`;
    await tx`
      insert into audit_log (workspace_id, deck_id, share_link_id, actor_user_id, action, details)
      values (
        ${workspaceId}, ${deckId}, ${linkId}, ${userId}, 'share_link.updated',
        ${JSON.stringify({ accessMode: body.access_mode, name: body.name })}::jsonb
      )
    `;
  });
}

export async function listAccessRequests(
  userId: string,
  deckId: string,
  linkId: string,
): Promise<readonly AccessRequestSummary[]> {
  const rows = await db.database()<
    {
      id: string;
      requested_email: string;
      status: 'pending' | 'approved' | 'denied';
      created_at: Date;
    }[]
  >`
    select ar.id, ar.requested_email, ar.status, ar.created_at
    from access_requests ar join share_links sl on sl.id = ar.share_link_id
    join decks d on d.id = sl.deck_id
    where d.id = ${deckId} and sl.id = ${linkId} and d.deleted_at is null
      and (d.owner_id = ${userId} or sl.creator_id = ${userId})
    order by ar.created_at desc
  `;
  const allowed = await db.database()<{ allowed: boolean }[]>`
    select exists (
      select 1 from share_links sl join decks d on d.id = sl.deck_id
      where d.id = ${deckId} and sl.id = ${linkId} and d.deleted_at is null
        and (d.owner_id = ${userId} or sl.creator_id = ${userId} and exists (
          select 1 from workspace_members wm where wm.workspace_id = d.workspace_id
            and wm.user_id = ${userId} and wm.status = 'active'
        ))
    ) as allowed
  `;
  if (!(allowed[0]?.allowed ?? false)) throw new DeckForbiddenError(deckId);
  return rows.map((row) => ({
    id: row.id,
    requestedEmail: row.requested_email,
    status: row.status,
    createdAt: row.created_at,
  }));
}
