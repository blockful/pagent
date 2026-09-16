import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app.ts';
import * as db from '../db.ts';
import { initDeckSchema } from './schema.ts';
import { integrationDatabaseUrl } from './test-database.ts';
import {
  createWorkspaceAdminFixture,
  getLatestAudit,
  getMemberRecord,
  workspaceAdminResponseSchema,
} from './workspace-admin-test-support.ts';

const databaseUrl = integrationDatabaseUrl('pagent_workspace_admin_d3a0_test');
const integration = describe.runIf(databaseUrl !== undefined);

integration('workspace administration routes', () => {
  const setup = postgres(databaseUrl ?? '', { ssl: false, prepare: false });
  let ownerCookie = '',
    adminCookie = '',
    memberCookie = '';
  let adminId = '';
  let ownerId = '';
  let reactivatedId = '';
  let removableId = '';
  let memberId = '';
  let workspaceId = '';
  let deckId = '';

  beforeAll(async () => {
    // Given
    await setup`drop schema public cascade`;
    await setup`create schema public`;
    await db.init(databaseUrl ?? '');
    await initDeckSchema(db.database());
    const fixture = await createWorkspaceAdminFixture();
    ({
      ownerCookie,
      adminCookie,
      memberCookie,
      ownerId,
      adminId,
      reactivatedId,
      removableId,
      memberId,
      workspaceId,
      deckId,
    } = fixture);
  });

  afterAll(async () => {
    await db.shutdown();
    await setup.end({ timeout: 5 });
  });

  it('returns workspace governance data to an owner', async () => {
    // When
    const response = await api({ path: '/v1/workspace', method: 'GET', cookie: ownerCookie });

    // Then
    expect(response.status).toBe(200);
    const body = workspaceAdminResponseSchema.parse(await response.json());
    expect(body.workspace).toEqual({
      id: workspaceId,
      name: "workspace-owner@pagent.test's workspace",
      role: 'owner',
      verifiedDomains: ['pagent.test'],
      analyticsConsentRequired: false,
      analyticsRetentionDays: 365,
      pageCount: 1,
    });
    expect(body.pages).toEqual([
      {
        id: deckId,
        title: 'Workspace launch',
        status: 'active',
        ownerEmail: 'workspace-owner@pagent.test',
        latestSenderEmail: null,
        linkCount: 0,
        updatedAt: expect.any(String),
      },
    ]);
    expect(body.members).toHaveLength(5);
    expect(body.teams).toEqual([
      expect.objectContaining({ name: 'Launch team', memberIds: [memberId] }),
    ]);
    expect(body.recentAuditEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'deck.published' })]),
    );
  });

  it('allows an active workspace admin to read governance data', async () => {
    // When
    const response = await api({ path: '/v1/workspace', method: 'GET', cookie: adminCookie });

    // Then
    expect(response.status).toBe(200);
    expect(workspaceAdminResponseSchema.parse(await response.json()).workspace.role).toBe('admin');
  });

  it('denies workspace governance data to an ordinary member', async () => {
    // When
    const response = await api({ path: '/v1/workspace', method: 'GET', cookie: memberCookie });

    // Then
    expect(response.status).toBe(403);
  });

  it('requires authentication for workspace governance data', async () => {
    // When
    const response = await api({ path: '/v1/workspace', method: 'GET', cookie: '' });

    // Then
    expect(response.status).toBe(401);
  });

  it('denies workspace mutations to an ordinary member', async () => {
    // When
    const add = await api({
      path: '/v1/workspace/members',
      method: 'POST',
      cookie: memberCookie,
      body: { email: 'reactivate@pagent.test', role: 'admin' },
    });
    const policy = await api({
      path: '/v1/workspace/policy',
      method: 'PUT',
      cookie: memberCookie,
      body: { consentRequired: true, retentionDays: 120 },
    });
    const remove = await api({
      path: `/v1/workspace/members/${removableId}`,
      method: 'DELETE',
      cookie: memberCookie,
    });

    // Then
    expect([add.status, policy.status, remove.status]).toEqual([403, 403, 403]);
  });

  it('reactivates an existing Pagent user and audits the change', async () => {
    // When
    const response = await api({
      path: '/v1/workspace/members',
      method: 'POST',
      cookie: adminCookie,
      body: { email: 'reactivate@pagent.test', role: 'admin' },
    });

    // Then
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: reactivatedId,
      role: 'admin',
      status: 'active',
    });
    await expect(getMemberRecord(workspaceId, reactivatedId)).resolves.toMatchObject({
      role: 'admin',
      status: 'active',
    });
    await expect(getLatestAudit(workspaceId)).resolves.toMatchObject({
      action: 'workspace.member_added',
    });
  });

  it('lets an admin update analytics policy and audits the change', async () => {
    // When
    const response = await api({
      path: '/v1/workspace/policy',
      method: 'PUT',
      cookie: adminCookie,
      body: { consentRequired: true, retentionDays: 120 },
    });

    // Then
    expect(response.status).toBe(204);
    const rows = await db.database()<
      { analytics_consent_required: boolean; analytics_retention_days: number }[]
    >`select analytics_consent_required, analytics_retention_days from workspaces where id = ${workspaceId}`;
    expect(rows[0]).toEqual({ analytics_consent_required: true, analytics_retention_days: 120 });
    await expect(getLatestAudit(workspaceId)).resolves.toMatchObject({
      action: 'analytics.policy_changed',
    });
  });

  it('suspends a non-owner member and audits the change', async () => {
    // When
    const response = await api({
      path: `/v1/workspace/members/${removableId}`,
      method: 'DELETE',
      cookie: adminCookie,
    });

    // Then
    expect(response.status).toBe(204);
    await expect(getMemberRecord(workspaceId, removableId)).resolves.toMatchObject({
      status: 'suspended',
    });
    await expect(getLatestAudit(workspaceId)).resolves.toMatchObject({
      action: 'workspace.member_removed',
    });
    const grants = await db.database()<{ collaborator: boolean; analytics_subject: boolean }[]>`
      select
        exists (select 1 from deck_collaborators where deck_id = ${deckId} and user_id = ${removableId})
          as collaborator,
        exists (select 1 from deck_analytics_subjects where deck_id = ${deckId}
          and subject_type = 'user' and subject_id = ${removableId}) as analytics_subject
    `;
    expect(grants[0]).toEqual({ collaborator: false, analytics_subject: false });

    // When
    const repeated = await api({
      path: `/v1/workspace/members/${removableId}`,
      method: 'DELETE',
      cookie: adminCookie,
    });

    // Then
    expect(repeated.status).toBe(204);
  });

  it('prevents an admin from removing an owner or themself', async () => {
    // When
    const ownerResponse = await api({
      path: `/v1/workspace/members/${ownerId}`,
      method: 'DELETE',
      cookie: adminCookie,
    });
    const selfResponse = await api({
      path: `/v1/workspace/members/${adminId}`,
      method: 'DELETE',
      cookie: adminCookie,
    });

    // Then
    expect(ownerResponse.status).toBe(403);
    expect(selfResponse.status).toBe(403);
  });

  it('hides team metadata from an ordinary member', async () => {
    // When
    const response = await api({
      path: '/v1/decks?scope=team',
      method: 'GET',
      cookie: memberCookie,
    });

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decks: [] });
  });

  it('keeps explicit shared grants visible to an ordinary member', async () => {
    // When
    const response = await api({
      path: '/v1/decks?scope=shared',
      method: 'GET',
      cookie: memberCookie,
    });

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decks: [expect.objectContaining({ id: deckId })],
    });
  });

  it('allows an active admin to use team scope', async () => {
    // When
    const response = await api({
      path: '/v1/decks?scope=team',
      method: 'GET',
      cookie: adminCookie,
    });

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decks: [expect.objectContaining({ id: deckId })],
    });
  });
});

type ApiInput = {
  readonly path: string;
  readonly method: string;
  readonly cookie: string;
  readonly body?: unknown;
};

async function api(input: ApiInput): Promise<Response> {
  return app.request(input.path, {
    method: input.method,
    headers: {
      cookie: input.cookie,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}
