import * as db from '../db.ts';

export type DeckListFilters = {
  readonly q?: string;
  readonly scope: 'mine' | 'shared' | 'team';
  readonly status?: 'active' | 'archived' | 'expired' | 'revoked';
  readonly owner?: string;
  readonly sender?: string;
};

export type DeckListItem = {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly latestSenderId: string | null;
  readonly latestSenderEmail: string | null;
  readonly status: 'active' | 'archived';
  readonly accessMode: 'anyone' | 'allowed_email' | 'authenticated' | null;
  readonly linkCount: number;
  readonly uniqueViewers: number;
  readonly lastViewed: Date | null;
  readonly updatedAt: Date;
};

export async function listDecks(
  userId: string,
  filters: DeckListFilters,
): Promise<readonly DeckListItem[]> {
  const database = db.database();
  const search = filters.q === undefined ? null : `%${filters.q.toLowerCase()}%`;
  const rows = await database<
    {
      id: string;
      title: string;
      owner_id: string;
      owner_email: string;
      latest_sender_id: string | null;
      latest_sender_email: string | null;
      status: 'active' | 'archived';
      access_mode: 'anyone' | 'allowed_email' | 'authenticated' | null;
      link_count: string;
      unique_viewers: string;
      last_viewed: Date | null;
      updated_at: Date;
    }[]
  >`
    select d.id, d.title, d.owner_id, owner.email as owner_email,
      latest_link.creator_id as latest_sender_id,
      sender.email as latest_sender_email, d.status, latest_link.access_mode,
      (select count(*) from share_links sl where sl.deck_id = d.id)::text as link_count,
      (
        select count(distinct coalesce(lower(v.viewer_email), v.viewer_session_id::text))
        from visits v join share_links sl on sl.id = v.share_link_id
        where sl.deck_id = d.id and v.excluded = false
      )::text as unique_viewers,
      (
        select max(v.started_at) from visits v
        join share_links sl on sl.id = v.share_link_id
        where sl.deck_id = d.id and v.excluded = false
      ) as last_viewed,
      d.updated_at
    from decks d
    join users owner on owner.id = d.owner_id
    left join lateral (
      select sl.creator_id, sl.access_mode
      from share_links sl where sl.deck_id = d.id
      order by sl.created_at desc limit 1
    ) latest_link on true
    left join users sender on sender.id = latest_link.creator_id
    where d.deleted_at is null
      and (${filters.owner ?? null}::uuid is null or d.owner_id = ${filters.owner ?? null})
      and (${filters.sender ?? null}::uuid is null or latest_link.creator_id = ${filters.sender ?? null})
      and (
        ${filters.scope} = 'mine' and d.owner_id = ${userId}
        or ${filters.scope} = 'shared' and exists (
          select 1 from deck_collaborators dc
          where dc.deck_id = d.id and dc.user_id = ${userId}
        )
        or ${filters.scope} = 'team' and exists (
          select 1 from workspace_members wm
          where wm.workspace_id = d.workspace_id and wm.user_id = ${userId} and wm.status = 'active'
        )
      )
      and (
        ${search}::text is null or lower(d.title) like ${search}
        or lower(coalesce(d.client_label, '')) like ${search}
        or lower(owner.email) like ${search}
        or lower(coalesce(sender.email, '')) like ${search}
        or exists (
          select 1 from share_links sl where sl.deck_id = d.id and lower(sl.name) like ${search}
        )
      )
      and (
        ${filters.status ?? null}::text is null
        or ${filters.status ?? null} in ('active', 'archived') and d.status = ${filters.status ?? null}
        or ${filters.status ?? null} = 'expired' and exists (
          select 1 from share_links sl where sl.deck_id = d.id and sl.expires_at <= now()
        )
        or ${filters.status ?? null} = 'revoked' and exists (
          select 1 from share_links sl where sl.deck_id = d.id and sl.revoked_at is not null
        )
      )
    order by d.updated_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    ownerEmail: row.owner_email,
    latestSenderId: row.latest_sender_id,
    latestSenderEmail: row.latest_sender_email,
    status: row.status,
    accessMode: row.access_mode,
    linkCount: Number(row.link_count),
    uniqueViewers: Number(row.unique_viewers),
    lastViewed: row.last_viewed,
    updatedAt: row.updated_at,
  }));
}
