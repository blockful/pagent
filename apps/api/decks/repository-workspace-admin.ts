import * as db from '../db.ts';
import { normalizeEmail } from './domain.ts';
import { listWorkspacePages, type WorkspacePageMetadata } from './repository-workspace-pages.ts';

type WorkspaceRole = 'owner' | 'admin';
type MemberRole = WorkspaceRole | 'member';
type MemberStatus = 'active' | 'suspended' | 'left';

export class WorkspaceAdminForbiddenError extends Error {
  readonly name = 'WorkspaceAdminForbiddenError';
  readonly userId: string;

  constructor(userId: string) {
    super(`user ${userId} cannot administer a workspace`);
    this.userId = userId;
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  readonly name = 'WorkspaceMemberNotFoundError';
  readonly member: string;

  constructor(member: string) {
    super(`workspace member ${member} was not found`);
    this.member = member;
  }
}

type ManagedWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly verifiedDomains: readonly string[];
  readonly analyticsConsentRequired: boolean;
  readonly analyticsRetentionDays: number;
  readonly pageCount: number;
};

async function managedWorkspace(userId: string): Promise<ManagedWorkspace> {
  const rows = await db.database()<
    {
      id: string;
      name: string;
      role: WorkspaceRole;
      verified_domains: string[];
      analytics_consent_required: boolean;
      analytics_retention_days: number;
      page_count: string;
    }[]
  >`
    select w.id, w.name, wm.role, w.verified_domains, w.analytics_consent_required,
      w.analytics_retention_days,
      (select count(*) from decks d where d.workspace_id = w.id and d.deleted_at is null)::text
        as page_count
    from workspace_members wm join workspaces w on w.id = wm.workspace_id
    where wm.user_id = ${userId} and wm.status = 'active' and wm.role in ('owner', 'admin')
    order by case wm.role when 'owner' then 0 else 1 end, wm.created_at
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) throw new WorkspaceAdminForbiddenError(userId);
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    verifiedDomains: row.verified_domains,
    analyticsConsentRequired: row.analytics_consent_required,
    analyticsRetentionDays: row.analytics_retention_days,
    pageCount: Number(row.page_count),
  };
}

export type WorkspaceMember = {
  readonly id: string;
  readonly email: string;
  readonly handle: string | null;
  readonly role: MemberRole;
  readonly status: MemberStatus;
};

export type WorkspaceAdminView = {
  readonly workspace: ManagedWorkspace;
  readonly pages: readonly WorkspacePageMetadata[];
  readonly members: readonly WorkspaceMember[];
  readonly teams: readonly {
    readonly id: string;
    readonly name: string;
    readonly memberIds: readonly string[];
  }[];
  readonly recentAuditEvents: readonly {
    readonly id: string;
    readonly action: string;
    readonly actorEmail: string | null;
    readonly details: unknown;
    readonly createdAt: Date;
  }[];
};

export async function getWorkspaceAdminView(userId: string): Promise<WorkspaceAdminView> {
  const workspace = await managedWorkspace(userId);
  const database = db.database();
  const [pages, members, teams, events] = await Promise.all([
    listWorkspacePages(workspace.id),
    database<
      { id: string; email: string; handle: string | null; role: MemberRole; status: MemberStatus }[]
    >`
      select u.id, u.email, u.handle, wm.role, wm.status
      from workspace_members wm join users u on u.id = wm.user_id
      where wm.workspace_id = ${workspace.id}
      order by case wm.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(u.email)
    `,
    database<{ id: string; name: string; member_ids: string[] }[]>`
      select t.id, t.name,
        coalesce(array_agg(tm.user_id order by tm.created_at)
          filter (where wm.status = 'active'), '{}') as member_ids
      from teams t
      left join team_members tm on tm.team_id = t.id
      left join workspace_members wm
        on wm.workspace_id = t.workspace_id and wm.user_id = tm.user_id
      where t.workspace_id = ${workspace.id}
      group by t.id order by lower(t.name)
    `,
    database<
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
      where a.workspace_id = ${workspace.id}
      order by a.created_at desc limit 100
    `,
  ]);
  return {
    workspace,
    pages,
    members,
    teams: teams.map((team) => ({ id: team.id, name: team.name, memberIds: team.member_ids })),
    recentAuditEvents: events.map((event) => ({
      id: event.id,
      action: event.action,
      actorEmail: event.actor_email,
      details: event.details,
      createdAt: event.created_at,
    })),
  };
}

type AddWorkspaceMemberInput = {
  readonly email: string;
  readonly role: 'admin' | 'member';
};

export async function addManagedWorkspaceMember(
  actorId: string,
  input: AddWorkspaceMemberInput,
): Promise<WorkspaceMember> {
  const workspace = await managedWorkspace(actorId);
  const users = await db.database()<{ id: string; email: string; handle: string | null }[]>`
    select id, email, handle from users where lower(email) = ${normalizeEmail(input.email)}
  `;
  const user = users[0];
  if (user === undefined) throw new WorkspaceMemberNotFoundError(input.email);
  if (user.id === actorId) throw new WorkspaceAdminForbiddenError(actorId);
  const membership = await db.database().begin(async (tx) => {
    const rows = await tx<{ role: 'admin' | 'member'; status: 'active' }[]>`
      insert into workspace_members (workspace_id, user_id, role, status)
      values (${workspace.id}, ${user.id}, ${input.role}, 'active')
      on conflict (workspace_id, user_id) do update
        set role = excluded.role, status = 'active'
        where workspace_members.role <> 'owner'
      returning role, status
    `;
    const row = rows[0];
    if (row === undefined) throw new WorkspaceAdminForbiddenError(actorId);
    await tx`
      insert into audit_log (workspace_id, actor_user_id, action, details)
      values (
        ${workspace.id}, ${actorId}, 'workspace.member_added',
        ${JSON.stringify({ memberId: user.id, role: row.role })}::jsonb
      )
    `;
    return row;
  });
  return { ...user, role: membership.role, status: membership.status };
}

type AnalyticsPolicy = {
  readonly consentRequired: boolean;
  readonly retentionDays: number;
};

export async function updateWorkspacePolicy(
  actorId: string,
  policy: AnalyticsPolicy,
): Promise<void> {
  const workspace = await managedWorkspace(actorId);
  await db.database().begin(async (tx) => {
    await tx`
      update workspaces set analytics_consent_required = ${policy.consentRequired},
        analytics_retention_days = ${policy.retentionDays}, updated_at = now()
      where id = ${workspace.id}
    `;
    await tx`
      insert into audit_log (workspace_id, actor_user_id, action, details)
      values (
        ${workspace.id}, ${actorId}, 'analytics.policy_changed', ${JSON.stringify(policy)}::jsonb
      )
    `;
  });
}

export async function suspendWorkspaceMember(actorId: string, memberId: string): Promise<void> {
  const workspace = await managedWorkspace(actorId);
  if (actorId === memberId) throw new WorkspaceAdminForbiddenError(actorId);
  await db.database().begin(async (tx) => {
    const removed = await tx<{ user_id: string }[]>`
      update workspace_members set status = 'suspended'
      where workspace_id = ${workspace.id} and user_id = ${memberId}
        and role <> 'owner'
      returning user_id
    `;
    if (removed.length === 0) throw new WorkspaceAdminForbiddenError(actorId);
    await tx`
      delete from team_members tm using teams t
      where tm.team_id = t.id and t.workspace_id = ${workspace.id} and tm.user_id = ${memberId}
    `;
    await tx`
      delete from deck_collaborators dc using decks d
      where dc.deck_id = d.id and d.workspace_id = ${workspace.id} and dc.user_id = ${memberId}
    `;
    await tx`
      delete from deck_analytics_subjects das using decks d
      where das.deck_id = d.id and d.workspace_id = ${workspace.id}
        and das.subject_type = 'user' and das.subject_id = ${memberId}
    `;
    await tx`
      insert into audit_log (workspace_id, actor_user_id, action, details)
      values (
        ${workspace.id}, ${actorId}, 'workspace.member_removed',
        ${JSON.stringify({ memberId })}::jsonb
      )
    `;
  });
}
