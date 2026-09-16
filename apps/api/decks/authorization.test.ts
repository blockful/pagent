import { describe, expect, it } from 'vitest';
import { canManageShareLink, canViewAnalytics } from './authorization.ts';

const base = {
  ownerId: 'owner',
  linkCreatorIds: ['sender'],
  selectedUserIds: ['selected'],
  selectedTeamMemberIds: ['teammate'],
  workspaceMemberIds: ['workspace-member'],
  activeWorkspaceMemberIds: ['owner', 'sender', 'selected', 'teammate', 'workspace-member'],
} as const;

describe('analytics authorization', () => {
  it('keeps private analytics to the owner and each relevant link creator', () => {
    // Given
    const visibility = 'private' as const;

    // When / Then
    expect(canViewAnalytics({ ...base, userId: 'owner', visibility })).toBe(true);
    expect(canViewAnalytics({ ...base, userId: 'sender', visibility })).toBe(true);
    expect(canViewAnalytics({ ...base, userId: 'workspace-member', visibility })).toBe(false);
  });

  it('requires active authenticated membership for selected, team, and workspace scopes', () => {
    // Given / When / Then
    expect(canViewAnalytics({ ...base, userId: 'selected', visibility: 'selected' })).toBe(true);
    expect(canViewAnalytics({ ...base, userId: 'teammate', visibility: 'team' })).toBe(true);
    expect(canViewAnalytics({ ...base, userId: 'workspace-member', visibility: 'workspace' })).toBe(
      true,
    );
    expect(
      canViewAnalytics({
        ...base,
        userId: 'former-member',
        visibility: 'workspace',
        workspaceMemberIds: ['former-member'],
      }),
    ).toBe(false);
  });
});

describe('share-link management authorization', () => {
  it('does not infer share management from analytics access', () => {
    // Given / When / Then
    expect(canManageShareLink({ userId: 'owner', ownerId: 'owner', linkCreatorId: 'sender' })).toBe(
      true,
    );
    expect(
      canManageShareLink({ userId: 'sender', ownerId: 'owner', linkCreatorId: 'sender' }),
    ).toBe(true);
    expect(
      canManageShareLink({ userId: 'selected', ownerId: 'owner', linkCreatorId: 'sender' }),
    ).toBe(false);
  });
});
