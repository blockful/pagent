import * as db from '../db.ts';
import { aggregateDeckAnalytics } from './analytics-aggregate.ts';
import type {
  AnalyticsEngagementRow,
  AnalyticsSlideRow,
  AnalyticsVisitRow,
  DeckAnalytics,
} from './analytics-types.ts';
import { canViewAnalytics } from './authorization.ts';
import type { AnalyticsVisibility, IdentityConfidence } from './domain.ts';
import { DeckForbiddenError } from './repository-decks.ts';

export type AnalyticsFilters = {
  readonly linkId?: string;
  readonly viewer?: string;
  readonly sender?: string;
  readonly revision?: number;
  readonly from?: string;
  readonly to?: string;
};

type AnalyticsAccess = {
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly restrictToCreator: boolean;
};

async function resolveAnalyticsAccess(userId: string, deckId: string): Promise<AnalyticsAccess> {
  const database = db.database();
  const decks = await database<
    {
      owner_id: string;
      owner_email: string;
      workspace_id: string;
      analytics_visibility: AnalyticsVisibility;
    }[]
  >`
    select d.owner_id, u.email as owner_email, d.workspace_id, d.analytics_visibility
    from decks d join users u on u.id = d.owner_id
    where d.id = ${deckId} and d.deleted_at is null
  `;
  const deck = decks[0];
  if (deck === undefined) throw new DeckForbiddenError(deckId);
  const [creatorRows, selectedRows, teamRows, workspaceRows] = await Promise.all([
    database<{ user_id: string }[]>`
      select distinct creator_id as user_id from share_links where deck_id = ${deckId}
    `,
    database<{ user_id: string }[]>`
      select subject_id as user_id from deck_analytics_subjects
      where deck_id = ${deckId} and subject_type = 'user'
    `,
    database<{ user_id: string }[]>`
      select distinct tm.user_id
      from deck_analytics_subjects das
      join team_members tm on tm.team_id = das.subject_id
      where das.deck_id = ${deckId} and das.subject_type = 'team'
    `,
    database<{ user_id: string }[]>`
      select user_id from workspace_members
      where workspace_id = ${deck.workspace_id} and status = 'active'
    `,
  ]);
  const creators = creatorRows.map((row) => row.user_id);
  const selected = selectedRows.map((row) => row.user_id);
  const teamMembers = teamRows.map((row) => row.user_id);
  const workspaceMembers = workspaceRows.map((row) => row.user_id);
  const allowed = canViewAnalytics({
    userId,
    ownerId: deck.owner_id,
    visibility: deck.analytics_visibility,
    linkCreatorIds: creators,
    selectedUserIds: selected,
    selectedTeamMemberIds: teamMembers,
    workspaceMemberIds: workspaceMembers,
    activeWorkspaceMemberIds: workspaceMembers,
  });
  if (!allowed) throw new DeckForbiddenError(deckId);
  const active = workspaceMembers.includes(userId);
  const scoped =
    userId === deck.owner_id ||
    (active && deck.analytics_visibility === 'selected' && selected.includes(userId)) ||
    (active && deck.analytics_visibility === 'team' && teamMembers.includes(userId)) ||
    (active && deck.analytics_visibility === 'workspace' && workspaceMembers.includes(userId));
  return {
    ownerId: deck.owner_id,
    ownerEmail: deck.owner_email,
    restrictToCreator: !scoped && creators.includes(userId),
  };
}

export async function getDeckAnalytics(
  userId: string,
  deckId: string,
  filters: AnalyticsFilters,
): Promise<DeckAnalytics> {
  const access = await resolveAnalyticsAccess(userId, deckId);
  const database = db.database();
  const viewerSearch = filters.viewer === undefined ? null : `%${filters.viewer.toLowerCase()}%`;
  const sender = access.restrictToCreator ? userId : (filters.sender ?? null);
  const visits = await database<
    {
      id: string;
      viewer_session_id: string;
      viewer_user_id: string | null;
      viewer_email: string | null;
      identity_confidence: IdentityConfidence;
      started_at: Date;
      last_activity_at: Date;
      revision_number: number;
      link_id: string;
      link_name: string;
      sender_id: string;
      sender_email: string;
      total_slides: string;
    }[]
  >`
    select v.id, v.viewer_session_id, vs.viewer_user_id, v.viewer_email,
      v.identity_confidence, v.started_at, v.last_activity_at,
      r.revision_number, sl.id as link_id, sl.name as link_name,
      sl.creator_id as sender_id, sender.email as sender_email,
      (select count(*) from deck_slides ds where ds.revision_id = v.revision_id)::text as total_slides
    from visits v
    join viewer_sessions vs on vs.id = v.viewer_session_id
    join share_links sl on sl.id = v.share_link_id
    join users sender on sender.id = sl.creator_id
    join deck_revisions r on r.id = v.revision_id
    where sl.deck_id = ${deckId} and v.excluded = false
      and (${filters.linkId ?? null}::uuid is null or sl.id = ${filters.linkId ?? null})
      and (${sender}::uuid is null or sl.creator_id = ${sender})
      and (${filters.revision ?? null}::integer is null or r.revision_number = ${filters.revision ?? null})
      and (${filters.from ?? null}::timestamptz is null or v.started_at >= ${filters.from ?? null})
      and (${filters.to ?? null}::timestamptz is null or v.started_at <= ${filters.to ?? null})
      and (
        ${viewerSearch}::text is null
        or lower(coalesce(v.viewer_email, 'anonymous')) like ${viewerSearch}
      )
    order by v.started_at desc
  `;
  const visitRows: readonly AnalyticsVisitRow[] = visits.map((visit) => ({
    id: visit.id,
    viewerSessionId: visit.viewer_session_id,
    viewerUserId: visit.viewer_user_id,
    viewerEmail: visit.viewer_email,
    identityConfidence: visit.identity_confidence,
    startedAt: visit.started_at,
    lastActivityAt: visit.last_activity_at,
    revisionNumber: visit.revision_number,
    linkId: visit.link_id,
    linkName: visit.link_name,
    senderId: visit.sender_id,
    senderEmail: visit.sender_email,
    totalSlides: Number(visit.total_slides),
  }));
  const slideRows = await database<
    {
      id: string;
      revision_number: number;
      stable_slide_id: string;
      ordinal: number;
      title: string | null;
    }[]
  >`
    select ds.id, r.revision_number, ds.stable_slide_id, ds.ordinal, ds.title
    from deck_slides ds join deck_revisions r on r.id = ds.revision_id
    where r.deck_id = ${deckId}
      and (${filters.revision ?? null}::integer is null or r.revision_number = ${filters.revision ?? null})
    order by r.revision_number desc, ds.ordinal
  `;
  const slides: readonly AnalyticsSlideRow[] = slideRows.map((slide) => ({
    id: slide.id,
    revisionNumber: slide.revision_number,
    stableSlideId: slide.stable_slide_id,
    ordinal: slide.ordinal,
    title: slide.title,
  }));
  if (visitRows.length === 0) {
    return aggregateDeckAnalytics({
      owner: { id: access.ownerId, email: access.ownerEmail },
      visitRows,
      slideRows: slides,
      engagementRows: [],
    });
  }
  const visitIds = visitRows.map((visit) => visit.id);
  const engagementRows = await database<
    {
      visit_id: string;
      id: string;
      revision_number: number;
      stable_slide_id: string;
      ordinal: number;
      title: string | null;
      active_duration_ms: string;
      view_count: number;
      qualified: boolean;
      first_sequence: number;
      last_sequence: number;
    }[]
  >`
    select se.visit_id, ds.id, r.revision_number, ds.stable_slide_id, ds.ordinal,
      ds.title, se.active_duration_ms::text, se.view_count, se.qualified,
      se.first_sequence, se.last_sequence
    from slide_engagement se
    join deck_slides ds on ds.id = se.slide_id
    join deck_revisions r on r.id = ds.revision_id
    where se.visit_id in ${database(visitIds)}
  `;
  const engagements: readonly AnalyticsEngagementRow[] = engagementRows.map((row) => ({
    visitId: row.visit_id,
    id: row.id,
    revisionNumber: row.revision_number,
    stableSlideId: row.stable_slide_id,
    ordinal: row.ordinal,
    title: row.title,
    activeDurationMs: Number(row.active_duration_ms),
    viewCount: row.view_count,
    qualified: row.qualified,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
  }));
  return aggregateDeckAnalytics({
    owner: { id: access.ownerId, email: access.ownerEmail },
    visitRows,
    slideRows: slides,
    engagementRows: engagements,
  });
}
