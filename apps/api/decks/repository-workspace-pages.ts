import * as db from '../db.ts';

export type WorkspacePageMetadata = {
  readonly id: string;
  readonly title: string;
  readonly status: 'active' | 'archived';
  readonly ownerEmail: string;
  readonly latestSenderEmail: string | null;
  readonly linkCount: number;
  readonly updatedAt: Date;
};

export async function listWorkspacePages(
  workspaceId: string,
): Promise<readonly WorkspacePageMetadata[]> {
  const rows = await db.database()<
    {
      id: string;
      title: string;
      status: 'active' | 'archived';
      owner_email: string;
      latest_sender_email: string | null;
      link_count: string;
      updated_at: Date;
    }[]
  >`
    select d.id, d.title, d.status, owner.email as owner_email,
      latest_link.sender_email as latest_sender_email,
      (select count(*) from share_links sl where sl.deck_id = d.id)::text as link_count,
      d.updated_at
    from decks d
    join users owner on owner.id = d.owner_id
    left join lateral (
      select sender.email as sender_email
      from share_links sl join users sender on sender.id = sl.creator_id
      where sl.deck_id = d.id order by sl.created_at desc limit 1
    ) latest_link on true
    where d.workspace_id = ${workspaceId} and d.deleted_at is null
    order by d.updated_at desc limit 100
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    ownerEmail: row.owner_email,
    latestSenderEmail: row.latest_sender_email,
    linkCount: Number(row.link_count),
    updatedAt: row.updated_at,
  }));
}
