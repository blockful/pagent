import type { AnalyticsVisibility } from './domain.ts';
import { DeckDataInvariantError } from './errors.ts';

type AnalyticsAuthorization = {
  readonly userId: string;
  readonly ownerId: string;
  readonly visibility: AnalyticsVisibility;
  readonly linkCreatorIds: readonly string[];
  readonly selectedUserIds: readonly string[];
  readonly selectedTeamMemberIds: readonly string[];
  readonly workspaceMemberIds: readonly string[];
  readonly activeWorkspaceMemberIds: readonly string[];
};

export function canViewAnalytics(input: AnalyticsAuthorization): boolean {
  if (input.userId === input.ownerId) return true;
  const activeMember = input.activeWorkspaceMemberIds.includes(input.userId);
  if (!activeMember) return false;
  if (input.linkCreatorIds.includes(input.userId)) return true;
  switch (input.visibility) {
    case 'private':
      return false;
    case 'selected':
      return input.selectedUserIds.includes(input.userId);
    case 'team':
      return input.selectedTeamMemberIds.includes(input.userId);
    case 'workspace':
      return input.workspaceMemberIds.includes(input.userId);
    default:
      return assertNever(input.visibility);
  }
}

type ShareLinkAuthorization = {
  readonly userId: string;
  readonly ownerId: string;
  readonly linkCreatorId: string;
};

export function canManageShareLink(input: ShareLinkAuthorization): boolean {
  return input.userId === input.ownerId || input.userId === input.linkCreatorId;
}

function assertNever(value: never): never {
  throw new DeckDataInvariantError(`Unexpected authorization variant: ${String(value)}`);
}
