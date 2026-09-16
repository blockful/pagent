// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import './product-navigation.ts';
import './workspace-admin.ts';
import type { WorkspaceAdminData, WorkspaceMember } from './workspace-admin-types.ts';

const WORKSPACE_ID = '9ea46b4d-58ae-4cdf-8de8-e41c255e628d';
const MEMBER_ID = '13d26c02-a80c-4b56-b1fa-1a91642684bf';

function workspaceResponse(overrides: Partial<WorkspaceAdminData> = {}): WorkspaceAdminData {
  return {
    workspace: {
      id: WORKSPACE_ID,
      name: 'Northstar',
      role: 'owner',
      verifiedDomains: ['northstar.test'],
      analyticsConsentRequired: true,
      analyticsRetentionDays: 90,
      pageCount: 12,
    },
    members: [
      {
        id: MEMBER_ID,
        email: 'owner@northstar.test',
        handle: 'owner',
        role: 'owner',
        status: 'active',
      },
    ],
    teams: [{ id: '65accbbd-7f3d-4080-a82c-d434a0ff0a19', name: 'Sales', memberIds: [MEMBER_ID] }],
    pages: [
      {
        id: 'fdb35ab0-33c1-445d-925d-f1ec9082fb33',
        title: 'Northstar renewal',
        status: 'active',
        ownerEmail: 'owner@northstar.test',
        latestSenderEmail: 'sender@northstar.test',
        linkCount: 2,
        updatedAt: '2026-09-16T01:00:00.000Z',
      },
    ],
    recentAuditEvents: [
      {
        id: '0246107e-e4d6-493b-9780-59a44b608754',
        action: 'workspace.policy.updated',
        actorEmail: 'owner@northstar.test',
        details: { retentionDays: 90 },
        createdAt: '2026-09-16T01:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

async function mount(): Promise<HTMLElement> {
  const element = document.createElement('workspace-admin');
  document.body.append(element);
  await Promise.resolve();
  return element;
}

describe('workspace-admin', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders workspace governance for an administrator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(workspaceResponse())),
    );
    const page = await mount();

    await vi.waitFor(() => {
      expect(page.shadowRoot?.querySelector('h1')?.textContent).toContain('Northstar');
    });
    expect(page.shadowRoot?.textContent).toContain('owner@northstar.test');
    expect(page.shadowRoot?.textContent).toContain('northstar.test');
    expect(page.shadowRoot?.textContent).toContain('90 days');
    expect(page.shadowRoot?.textContent).toContain('Northstar renewal');
    expect(page.shadowRoot?.textContent).toContain('does not grant access');
    expect(page.shadowRoot?.querySelector('product-navigation')?.getAttribute('current')).toBe(
      'admin',
    );
  });

  it('presents legacy audit event names using the Page vocabulary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          workspaceResponse({
            recentAuditEvents: [
              {
                id: '0246107e-e4d6-493b-9780-59a44b608754',
                action: 'deck.published',
                actorEmail: 'owner@northstar.test',
                details: { deckTitle: 'Northstar renewal' },
                createdAt: '2026-09-16T01:00:00.000Z',
              },
            ],
          }),
        ),
      ),
    );
    const page = await mount();

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('page published'));
    expect(page.shadowRoot?.textContent).toContain('page title: Northstar renewal');
    expect(page.shadowRoot?.textContent).not.toMatch(/\bdeck\b/i);
  });

  it('shows sign-in and forbidden states without exposing admin controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const signedOut = await mount();
    await vi.waitFor(() => expect(signedOut.shadowRoot?.textContent).toContain('Sign in'));
    expect(signedOut.shadowRoot?.querySelector('form')).toBeNull();

    document.body.replaceChildren();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const forbidden = await mount();
    await vi.waitFor(() => expect(forbidden.shadowRoot?.textContent).toContain('administrator'));
    expect(forbidden.shadowRoot?.querySelector('form')).toBeNull();
  });

  it('renders explicit empty states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          workspaceResponse({ members: [], teams: [], pages: [], recentAuditEvents: [] }),
        ),
      ),
    );
    const page = await mount();

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('No members yet'));
    expect(page.shadowRoot?.textContent).toContain('No teams configured');
    expect(page.shadowRoot?.textContent).toContain('No presentation pages');
    expect(page.shadowRoot?.textContent).toContain('No workspace activity yet');
  });

  it('adds a member and confirms the mutation inline', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = input.toString();
      if (path.endsWith('/v1/workspace/members')) return new Response(null, { status: 204 });
      return Response.json(workspaceResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    const page = await mount();
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector('#member-email')).not.toBeNull());

    const email = page.shadowRoot?.querySelector<HTMLInputElement>('#member-email');
    if (email === null || email === undefined) throw new TypeError('Missing member email input');
    email.value = 'new@northstar.test';
    email.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    page.shadowRoot
      ?.querySelector<HTMLFormElement>('#member-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: true }));

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('Member added'));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/workspace/members'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@northstar.test', role: 'member' }),
      }),
    );
  });

  it('updates analytics policy and reports failures inline', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = input.toString();
      if (path.endsWith('/v1/workspace/policy')) {
        return Response.json({ message: 'Policy could not be saved' }, { status: 500 });
      }
      return Response.json(workspaceResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    const page = await mount();
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector('#policy-form')).not.toBeNull());

    page.shadowRoot
      ?.querySelector<HTMLFormElement>('#policy-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: true }));

    await vi.waitFor(() =>
      expect(page.shadowRoot?.textContent).toContain('Policy could not be saved'),
    );
  });

  it('removes a member and confirms the mutation inline', async () => {
    const member: WorkspaceMember = {
      id: 'b03559ca-2225-412e-976f-52dbb73e3358',
      email: 'member@northstar.test',
      handle: null,
      role: 'member',
      status: 'active',
    };
    const response = workspaceResponse({ members: [...workspaceResponse().members, member] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith(`/v1/workspace/members/${member.id}`)) {
        return new Response(null, { status: 204 });
      }
      return Response.json(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const page = await mount();
    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain(member.email));

    const removeButton = Array.from(page.shadowRoot?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Remove',
    );
    removeButton?.click();

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('Member removed'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(member.email));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/workspace/members/${member.id}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('sends the complete analytics policy and confirms success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith('/v1/workspace/policy')) {
        return new Response(null, { status: 204 });
      }
      return Response.json(workspaceResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    const page = await mount();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector('#retention-days')).not.toBeNull(),
    );

    const retention = page.shadowRoot?.querySelector<HTMLInputElement>('#retention-days');
    if (retention === null || retention === undefined)
      throw new TypeError('Missing retention input');
    retention.value = '180';
    retention.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    page.shadowRoot
      ?.querySelector<HTMLFormElement>('#policy-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: true }));

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('Policy saved'));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/workspace/policy'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ consentRequired: true, retentionDays: 180 }),
      }),
    );
  });

  it('shows a recoverable page error for an unavailable workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'Service unavailable' }, { status: 503 })),
    );
    const page = await mount();

    await vi.waitFor(() => expect(page.shadowRoot?.textContent).toContain('Service unavailable'));
    expect(page.shadowRoot?.textContent).toContain('Try again');
  });
});
