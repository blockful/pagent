import { z } from 'zod';
import { SESSION_COOKIE_NAME } from '../auth/middleware.ts';
import { createSession } from '../auth/session.ts';
import * as db from '../db.ts';
import { publishDeck } from './repository-decks.ts';
import { createTeam, setDeckCollaborators } from './repository-permissions.ts';

const memberSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  handle: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  status: z.enum(['active', 'suspended', 'left']),
});

const pageMetadataSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    status: z.enum(['active', 'archived']),
    ownerEmail: z.string().email(),
    latestSenderEmail: z.string().email().nullable(),
    linkCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const workspaceAdminResponseSchema = z.object({
  workspace: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    role: z.enum(['owner', 'admin']),
    verifiedDomains: z.array(z.string()),
    analyticsConsentRequired: z.boolean(),
    analyticsRetentionDays: z.number().int(),
    pageCount: z.number().int().nonnegative(),
  }),
  pages: z.array(pageMetadataSchema).max(100),
  members: z.array(memberSchema),
  teams: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      memberIds: z.array(z.string().uuid()),
    }),
  ),
  recentAuditEvents: z.array(
    z.object({
      id: z.string().uuid(),
      action: z.string().min(1),
      actorEmail: z.string().email().nullable(),
      details: z.unknown(),
      createdAt: z.string().datetime(),
    }),
  ),
});

export type WorkspaceAdminFixture = {
  readonly ownerCookie: string;
  readonly adminCookie: string;
  readonly memberCookie: string;
  readonly adminId: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly reactivatedId: string;
  readonly removableId: string;
  readonly workspaceId: string;
  readonly deckId: string;
};

export async function createWorkspaceAdminFixture(): Promise<WorkspaceAdminFixture> {
  const users = await Promise.all(
    [
      ['workspace-owner@pagent.test', 'workspace-owner'],
      ['workspace-admin@pagent.test', 'workspace-admin'],
      ['workspace-member@pagent.test', 'workspace-member'],
      ['reactivate@pagent.test', 'reactivate'],
      ['remove@pagent.test', 'remove'],
    ].map(([email, handle]) => db.upsertUser({ email, handle, name: handle, avatarUrl: null })),
  );
  const [owner, admin, member, reactivated, removable] = users;
  if (
    owner === undefined ||
    admin === undefined ||
    member === undefined ||
    reactivated === undefined ||
    removable === undefined
  ) {
    throw new TypeError('workspace admin fixtures were not created');
  }
  const deck = await publishDeck(
    { id: owner.id, email: owner.email },
    { title: 'Workspace launch', slides: [{ id: 'cover', html: '<h1>Launch</h1>' }] },
  );
  const workspaces = await db.database()<{ workspace_id: string }[]>`
    select workspace_id from decks where id = ${deck.deckId}
  `;
  const workspaceId = workspaces[0]?.workspace_id;
  if (workspaceId === undefined) throw new TypeError('workspace fixture was not created');
  await db.database()`
    update workspaces set verified_domains = ${['pagent.test']} where id = ${workspaceId}
  `;
  await db.database()`
    insert into workspace_members (workspace_id, user_id, role, status) values
      (${workspaceId}, ${admin.id}, 'admin', 'active'),
      (${workspaceId}, ${member.id}, 'member', 'active'),
      (${workspaceId}, ${reactivated.id}, 'member', 'suspended'),
      (${workspaceId}, ${removable.id}, 'member', 'active')
  `;
  await setDeckCollaborators(owner.id, deck.deckId, [member.id, removable.id]);
  await db.database()`
    insert into deck_analytics_subjects (deck_id, subject_type, subject_id)
    values (${deck.deckId}, 'user', ${removable.id})
  `;
  await createTeam(owner.id, deck.deckId, { name: 'Launch team', memberIds: [member.id] });
  return {
    ownerCookie: `${SESSION_COOKIE_NAME}=${await createSession(owner.id)}`,
    adminCookie: `${SESSION_COOKIE_NAME}=${await createSession(admin.id)}`,
    memberCookie: `${SESSION_COOKIE_NAME}=${await createSession(member.id)}`,
    adminId: admin.id,
    ownerId: owner.id,
    memberId: member.id,
    reactivatedId: reactivated.id,
    removableId: removable.id,
    workspaceId,
    deckId: deck.deckId,
  };
}

export async function getMemberRecord(workspaceId: string, userId: string) {
  const rows = await db.database()<
    { role: 'owner' | 'admin' | 'member'; status: 'active' | 'suspended' | 'left' }[]
  >`
    select role, status from workspace_members
    where workspace_id = ${workspaceId} and user_id = ${userId}
  `;
  return rows[0];
}

export async function getLatestAudit(workspaceId: string) {
  const rows = await db.database()<{ action: string }[]>`
    select action from audit_log where workspace_id = ${workspaceId}
    order by created_at desc limit 1
  `;
  return rows[0];
}
