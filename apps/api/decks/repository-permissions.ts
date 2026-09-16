import * as db from '../db.ts';
import type { AnalyticsVisibility } from './domain.ts';
import { normalizeEmail } from './domain.ts';
import { DeckDataInvariantError } from './errors.ts';
import { DeckForbiddenError } from './repository-decks.ts';

type VisibilityChange = {
  readonly scope: AnalyticsVisibility;
  readonly subjectIds: readonly string[];
};

type AudienceMember = {
  readonly id: string;
  readonly email: string;
  readonly handle: string | null;
};

export type AnalyticsAudiencePreview = {
  readonly scope: AnalyticsVisibility;
  readonly audience: readonly AudienceMember[];
};

type OwnedDeck = {
  readonly workspaceId: string;
};

async function ownedDeck(userId: string, deckId: string): Promise<OwnedDeck> {
  const rows = await db.database()<{ workspace_id: string }[]>`
    select workspace_id from decks
    where id = ${deckId} and owner_id = ${userId} and deleted_at is null
  `;
  const workspaceId = rows[0]?.workspace_id;
  if (workspaceId === undefined) throw new DeckForbiddenError(deckId);
  return { workspaceId };
}

type AddMemberInput = {
  readonly email: string;
  readonly role: 'admin' | 'member';
};

export async function addWorkspaceMember(
  userId: string,
  deckId: string,
  input: AddMemberInput,
): Promise<AudienceMember> {
  const deck = await ownedDeck(userId, deckId);
  const users = await db.database()<AudienceMember[]>`
    select id, email, handle from users where lower(email) = ${normalizeEmail(input.email)}
  `;
  const member = users[0];
  if (member === undefined) throw new DeckForbiddenError(deckId);
  await db.database().begin(async (tx) => {
    await tx`
      insert into workspace_members (workspace_id, user_id, role, status)
      values (${deck.workspaceId}, ${member.id}, ${input.role}, 'active')
      on conflict (workspace_id, user_id) do update
        set role = excluded.role, status = 'active'
    `;
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${deck.workspaceId}, ${deckId}, ${userId}, 'workspace.member_added',
        ${JSON.stringify({ memberId: member.id, role: input.role })}::jsonb
      )
    `;
  });
  return member;
}

type CreateTeamInput = {
  readonly name: string;
  readonly memberIds: readonly string[];
};

export async function createTeam(
  userId: string,
  deckId: string,
  input: CreateTeamInput,
): Promise<{ readonly id: string; readonly name: string }> {
  const deck = await ownedDeck(userId, deckId);
  const active = await db.database()<{ user_id: string }[]>`
    select user_id from workspace_members
    where workspace_id = ${deck.workspaceId} and status = 'active'
      and user_id in ${db.database()(input.memberIds)}
  `;
  if (active.length !== new Set(input.memberIds).size) throw new DeckForbiddenError(deckId);
  return db.database().begin(async (tx) => {
    const teams = await tx<{ id: string }[]>`
      insert into teams (workspace_id, name) values (${deck.workspaceId}, ${input.name})
      returning id
    `;
    const teamId = teams[0]?.id;
    if (teamId === undefined) {
      throw new DeckDataInvariantError('team insert returned no id');
    }
    for (const memberId of input.memberIds) {
      await tx`insert into team_members (team_id, user_id) values (${teamId}, ${memberId})`;
    }
    return { id: teamId, name: input.name };
  });
}

async function visibilityAudience(
  workspaceId: string,
  deckId: string,
  change: VisibilityChange,
): Promise<readonly AudienceMember[]> {
  const database = db.database();
  const members = await database<AudienceMember[]>`
    select distinct u.id, u.email, u.handle
    from users u
    join workspace_members wm on wm.user_id = u.id and wm.workspace_id = ${workspaceId}
    where wm.status = 'active' and (
      u.id = (select owner_id from decks where id = ${deckId})
      or u.id in (select creator_id from share_links where deck_id = ${deckId})
      or ${change.scope} = 'selected' and u.id in ${database(change.subjectIds)}
      or ${change.scope} = 'team' and u.id in (
        select tm.user_id from team_members tm
        join teams t on t.id = tm.team_id
        where t.workspace_id = ${workspaceId} and t.id in ${database(change.subjectIds)}
      )
      or ${change.scope} = 'workspace'
    ) order by u.email
  `;
  const requiredSubjects = change.scope === 'selected' || change.scope === 'team';
  if (requiredSubjects && change.subjectIds.length === 0) throw new DeckForbiddenError(deckId);
  if (change.scope === 'selected') {
    const activeIds = new Set(members.map((member) => member.id));
    if (change.subjectIds.some((subjectId) => !activeIds.has(subjectId))) {
      throw new DeckForbiddenError(deckId);
    }
  }
  if (change.scope === 'team') {
    const teams = await database<{ id: string }[]>`
      select id from teams where workspace_id = ${workspaceId} and id in ${database(change.subjectIds)}
    `;
    if (teams.length !== new Set(change.subjectIds).size) throw new DeckForbiddenError(deckId);
  }
  return members;
}

export async function previewAnalyticsVisibility(
  userId: string,
  deckId: string,
  change: VisibilityChange,
): Promise<AnalyticsAudiencePreview> {
  const deck = await ownedDeck(userId, deckId);
  return {
    scope: change.scope,
    audience: await visibilityAudience(deck.workspaceId, deckId, change),
  };
}

export async function setAnalyticsVisibility(
  userId: string,
  deckId: string,
  change: VisibilityChange,
): Promise<AnalyticsAudiencePreview> {
  const deck = await ownedDeck(userId, deckId);
  const audience = await visibilityAudience(deck.workspaceId, deckId, change);
  await db.database().begin(async (tx) => {
    await tx`delete from deck_analytics_subjects where deck_id = ${deckId}`;
    const subjectType = change.scope === 'team' ? 'team' : 'user';
    if (change.scope === 'selected' || change.scope === 'team') {
      for (const subjectId of change.subjectIds) {
        await tx`
          insert into deck_analytics_subjects (deck_id, subject_type, subject_id)
          values (${deckId}, ${subjectType}, ${subjectId})
        `;
      }
    }
    await tx`
      update decks set analytics_visibility = ${change.scope}, updated_at = now()
      where id = ${deckId}
    `;
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${deck.workspaceId}, ${deckId}, ${userId}, 'analytics.visibility_changed',
        ${JSON.stringify({ scope: change.scope, audienceIds: audience.map((member) => member.id) })}::jsonb
      )
    `;
  });
  return { scope: change.scope, audience };
}

export async function setDeckCollaborators(
  userId: string,
  deckId: string,
  collaboratorIds: readonly string[],
): Promise<void> {
  const deck = await ownedDeck(userId, deckId);
  const active = await db.database()<{ user_id: string }[]>`
    select user_id from workspace_members
    where workspace_id = ${deck.workspaceId} and status = 'active'
      and user_id in ${db.database()(collaboratorIds)}
  `;
  if (active.length !== new Set(collaboratorIds).size) throw new DeckForbiddenError(deckId);
  await db.database().begin(async (tx) => {
    await tx`delete from deck_collaborators where deck_id = ${deckId}`;
    for (const collaboratorId of collaboratorIds) {
      await tx`
        insert into deck_collaborators (deck_id, user_id, can_view_content)
        values (${deckId}, ${collaboratorId}, true)
      `;
    }
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${deck.workspaceId}, ${deckId}, ${userId}, 'deck.collaborators_changed',
        ${JSON.stringify({ collaboratorIds })}::jsonb
      )
    `;
  });
}
