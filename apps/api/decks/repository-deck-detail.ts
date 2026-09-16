import * as db from '../db.ts';
import type { AnalyticsVisibility } from './domain.ts';
import { DeckForbiddenError } from './repository-decks.ts';

type DeckDetail = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly clientLabel: string | null;
  readonly status: 'active' | 'archived';
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly analyticsVisibility: AnalyticsVisibility;
  readonly latestRevisionNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastPublishedAt: Date;
  readonly revisions: readonly {
    readonly id: string;
    readonly revisionNumber: number;
    readonly slideCount: number;
    readonly createdByEmail: string;
    readonly createdAt: Date;
  }[];
  readonly recentActivity: readonly {
    readonly id: string;
    readonly action: string;
    readonly actorEmail: string | null;
    readonly createdAt: Date;
  }[];
};

export async function getDeckDetail(userId: string, deckId: string): Promise<DeckDetail> {
  const database = db.database();
  const rows = await database<
    {
      id: string;
      title: string;
      description: string | null;
      client_label: string | null;
      status: 'active' | 'archived';
      owner_id: string;
      owner_email: string;
      analytics_visibility: AnalyticsVisibility;
      latest_revision_number: number;
      created_at: Date;
      updated_at: Date;
      last_published_at: Date;
    }[]
  >`
    select d.id, d.title, d.description, d.client_label, d.status, d.owner_id,
      owner.email as owner_email, d.analytics_visibility, d.latest_revision_number,
      d.created_at, d.updated_at, latest.created_at as last_published_at
    from decks d
    join users owner on owner.id = d.owner_id
    join deck_revisions latest
      on latest.deck_id = d.id and latest.revision_number = d.latest_revision_number
    where d.id = ${deckId} and d.deleted_at is null and (
      d.owner_id = ${userId} or exists (
        select 1 from deck_collaborators dc
        join workspace_members wm
          on wm.workspace_id = d.workspace_id and wm.user_id = dc.user_id
        where dc.deck_id = d.id and dc.user_id = ${userId}
          and dc.can_view_content = true and wm.status = 'active'
      )
    )
  `;
  const deck = rows[0];
  if (deck === undefined) throw new DeckForbiddenError(deckId);
  const [revisionRows, activityRows] = await Promise.all([
    database<
      {
        id: string;
        revision_number: number;
        slide_count: string;
        created_by_email: string;
        created_at: Date;
      }[]
    >`
      select r.id, r.revision_number, count(s.id)::text as slide_count,
        creator.email as created_by_email, r.created_at
      from deck_revisions r
      join users creator on creator.id = r.created_by
      left join deck_slides s on s.revision_id = r.id
      where r.deck_id = ${deckId}
      group by r.id, creator.email order by r.revision_number desc
    `,
    database<{ id: string; action: string; actor_email: string | null; created_at: Date }[]>`
      select a.id, a.action, actor.email as actor_email, a.created_at
      from audit_log a left join users actor on actor.id = a.actor_user_id
      where a.deck_id = ${deckId} order by a.created_at desc limit 20
    `,
  ]);
  return {
    id: deck.id,
    title: deck.title,
    description: deck.description,
    clientLabel: deck.client_label,
    status: deck.status,
    ownerId: deck.owner_id,
    ownerEmail: deck.owner_email,
    analyticsVisibility: deck.analytics_visibility,
    latestRevisionNumber: deck.latest_revision_number,
    createdAt: deck.created_at,
    updatedAt: deck.updated_at,
    lastPublishedAt: deck.last_published_at,
    revisions: revisionRows.map((revision) => ({
      id: revision.id,
      revisionNumber: revision.revision_number,
      slideCount: Number(revision.slide_count),
      createdByEmail: revision.created_by_email,
      createdAt: revision.created_at,
    })),
    recentActivity: activityRows.map((activity) => ({
      id: activity.id,
      action: activity.action,
      actorEmail: activity.actor_email,
      createdAt: activity.created_at,
    })),
  };
}
