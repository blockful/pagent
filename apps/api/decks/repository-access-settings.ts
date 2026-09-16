import { createHash } from 'node:crypto';
import * as db from '../db.ts';
import { normalizeEmail, type AnalyticsVisibility } from './domain.ts';
import { DeckForbiddenError } from './repository-decks.ts';

type AccessSettings = {
  readonly analyticsVisibility: AnalyticsVisibility;
  readonly analyticsConsentRequired: boolean;
  readonly analyticsRetentionDays: number;
  readonly members: readonly {
    readonly id: string;
    readonly email: string;
    readonly handle: string | null;
    readonly role: 'owner' | 'admin' | 'member';
    readonly status: 'active' | 'suspended' | 'left';
    readonly canViewContent: boolean;
    readonly selectedForAnalytics: boolean;
  }[];
  readonly teams: readonly {
    readonly id: string;
    readonly name: string;
    readonly selectedForAnalytics: boolean;
    readonly memberIds: readonly string[];
  }[];
};

async function ownerWorkspace(userId: string, deckId: string): Promise<string> {
  const rows = await db.database()<{ workspace_id: string }[]>`
    select workspace_id from decks
    where id = ${deckId} and owner_id = ${userId} and deleted_at is null
  `;
  const workspaceId = rows[0]?.workspace_id;
  if (workspaceId === undefined) throw new DeckForbiddenError(deckId);
  return workspaceId;
}

export async function getAccessSettings(userId: string, deckId: string): Promise<AccessSettings> {
  const workspaceId = await ownerWorkspace(userId, deckId);
  const database = db.database();
  const [decks, members, teams] = await Promise.all([
    database<
      {
        analytics_visibility: AnalyticsVisibility;
        analytics_consent_required: boolean;
        analytics_retention_days: number;
      }[]
    >`
      select d.analytics_visibility, w.analytics_consent_required, w.analytics_retention_days
      from decks d join workspaces w on w.id = d.workspace_id where d.id = ${deckId}
    `,
    database<
      {
        id: string;
        email: string;
        handle: string | null;
        role: 'owner' | 'admin' | 'member';
        status: 'active' | 'suspended' | 'left';
        can_view_content: boolean;
        selected_for_analytics: boolean;
      }[]
    >`
      select u.id, u.email, u.handle, wm.role, wm.status,
        coalesce(dc.can_view_content, false) as can_view_content,
        exists (
          select 1 from deck_analytics_subjects das where das.deck_id = ${deckId}
            and das.subject_type = 'user' and das.subject_id = u.id
        ) as selected_for_analytics
      from workspace_members wm join users u on u.id = wm.user_id
      left join deck_collaborators dc on dc.deck_id = ${deckId} and dc.user_id = u.id
      where wm.workspace_id = ${workspaceId} order by u.email
    `,
    database<
      {
        id: string;
        name: string;
        selected_for_analytics: boolean;
        member_ids: string[];
      }[]
    >`
      select t.id, t.name,
        exists (
          select 1 from deck_analytics_subjects das where das.deck_id = ${deckId}
            and das.subject_type = 'team' and das.subject_id = t.id
        ) as selected_for_analytics,
        coalesce(array_agg(tm.user_id) filter (where tm.user_id is not null), '{}') as member_ids
      from teams t left join team_members tm on tm.team_id = t.id
      where t.workspace_id = ${workspaceId} group by t.id order by t.name
    `,
  ]);
  const deck = decks[0];
  if (deck === undefined) throw new DeckForbiddenError(deckId);
  return {
    analyticsVisibility: deck.analytics_visibility,
    analyticsConsentRequired: deck.analytics_consent_required,
    analyticsRetentionDays: deck.analytics_retention_days,
    members: members.map((member) => ({
      id: member.id,
      email: member.email,
      handle: member.handle,
      role: member.role,
      status: member.status,
      canViewContent: member.can_view_content,
      selectedForAnalytics: member.selected_for_analytics,
    })),
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      selectedForAnalytics: team.selected_for_analytics,
      memberIds: team.member_ids,
    })),
  };
}

type AnalyticsPolicy = {
  readonly consentRequired: boolean;
  readonly retentionDays: number;
};

export type AuditEvent = {
  readonly id: string;
  readonly action: string;
  readonly actorEmail: string | null;
  readonly details: unknown;
  readonly createdAt: Date;
};

export async function setAnalyticsPolicy(
  userId: string,
  deckId: string,
  policy: AnalyticsPolicy,
): Promise<void> {
  const workspaceId = await ownerWorkspace(userId, deckId);
  await db.database().begin(async (tx) => {
    await tx`
      update workspaces set analytics_consent_required = ${policy.consentRequired},
        analytics_retention_days = ${policy.retentionDays}, updated_at = now()
      where id = ${workspaceId}
    `;
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${workspaceId}, ${deckId}, ${userId}, 'analytics.policy_changed',
        ${JSON.stringify(policy)}::jsonb
      )
    `;
  });
}

export async function removeWorkspaceMember(
  userId: string,
  deckId: string,
  memberId: string,
): Promise<void> {
  const workspaceId = await ownerWorkspace(userId, deckId);
  if (memberId === userId) throw new DeckForbiddenError(deckId);
  await db.database().begin(async (tx) => {
    const rows = await tx<{ user_id: string }[]>`
      update workspace_members set status = 'suspended'
      where workspace_id = ${workspaceId} and user_id = ${memberId} and status = 'active'
      returning user_id
    `;
    if (rows.length === 0) throw new DeckForbiddenError(deckId);
    await tx`delete from deck_collaborators where deck_id = ${deckId} and user_id = ${memberId}`;
    await tx`delete from deck_analytics_subjects where deck_id = ${deckId} and subject_type = 'user' and subject_id = ${memberId}`;
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${workspaceId}, ${deckId}, ${userId}, 'workspace.member_removed',
        ${JSON.stringify({ memberId })}::jsonb
      )
    `;
  });
}

export async function deleteViewerAnalytics(
  userId: string,
  deckId: string,
  email: string,
): Promise<number> {
  const workspaceId = await ownerWorkspace(userId, deckId);
  const normalized = normalizeEmail(email);
  return db.database().begin(async (tx) => {
    const removed = await tx<{ id: string }[]>`
      delete from visits v using share_links sl
      where v.share_link_id = sl.id and sl.deck_id = ${deckId}
        and lower(v.viewer_email) = ${normalized}
      returning v.id
    `;
    const emailHash = createHash('sha256').update(normalized).digest('hex');
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${workspaceId}, ${deckId}, ${userId}, 'analytics.viewer_deleted',
        ${JSON.stringify({ emailHash, visitsRemoved: removed.length })}::jsonb
      )
    `;
    return removed.length;
  });
}

export async function getAuditLog(userId: string, deckId: string): Promise<readonly AuditEvent[]> {
  await ownerWorkspace(userId, deckId);
  const rows = await db.database()<
    {
      id: string;
      action: string;
      actor_email: string | null;
      details: unknown;
      created_at: Date;
    }[]
  >`
    select a.id, a.action, u.email as actor_email, a.details, a.created_at
    from audit_log a left join users u on u.id = a.actor_user_id
    where a.deck_id = ${deckId} order by a.created_at desc limit 200
  `;
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorEmail: row.actor_email,
    details: row.details,
    createdAt: row.created_at,
  }));
}

export async function purgeExpiredAnalytics(): Promise<number> {
  const rows = await db.database()<{ id: string }[]>`
    delete from visits v using share_links sl, decks d, workspaces w
    where v.share_link_id = sl.id and sl.deck_id = d.id and d.workspace_id = w.id
      and v.started_at < now() - make_interval(days => w.analytics_retention_days)
    returning v.id
  `;
  return rows.length;
}
