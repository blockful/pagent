import { z } from 'zod';

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member']);
const managedWorkspaceRoleSchema = z.enum(['owner', 'admin']);

const workspaceMemberSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  handle: z.string().nullable(),
  role: workspaceRoleSchema,
  status: z.enum(['active', 'suspended', 'left']),
});

const workspaceTeamSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  memberIds: z.array(z.string().uuid()),
});

const workspaceAuditSchema = z.object({
  id: z.string().uuid(),
  action: z.string().min(1),
  actorEmail: z.string().email().nullable(),
  details: z.unknown(),
  createdAt: z.string().datetime(),
});

const workspacePageSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  status: z.enum(['active', 'archived']),
  ownerEmail: z.string().email(),
  latestSenderEmail: z.string().email().nullable(),
  linkCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const workspaceAdminSchema = z.object({
  workspace: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    role: managedWorkspaceRoleSchema,
    verifiedDomains: z.array(z.string().min(1)),
    analyticsConsentRequired: z.boolean(),
    analyticsRetentionDays: z.number().int().positive(),
    pageCount: z.number().int().nonnegative(),
  }),
  members: z.array(workspaceMemberSchema),
  teams: z.array(workspaceTeamSchema),
  pages: z.array(workspacePageSchema),
  recentAuditEvents: z.array(workspaceAuditSchema),
});

export const memberInvitationSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'member']),
});

export const workspacePolicySchema = z.object({
  consentRequired: z.boolean(),
  retentionDays: z.number().int().min(30).max(2555),
});

export type WorkspaceAdminData = z.infer<typeof workspaceAdminSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceAuditEvent = z.infer<typeof workspaceAuditSchema>;

export function canAdministerWorkspace(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}
