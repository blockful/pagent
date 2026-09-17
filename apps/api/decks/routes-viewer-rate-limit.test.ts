import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.ts';

vi.mock('./repository-sharing.ts', () => ({
  getAccessRequestStatus: vi.fn(async () => 'pending'),
  getShareMetadata: vi.fn(async () => ({})),
  grantViewerAccess: vi.fn(async () => ({ kind: 'granted', sessionToken: 's'.repeat(32) })),
  requestAccess: vi.fn(async () => ({ requestId: '11111111-1111-4111-8111-111111111111' })),
}));
vi.mock('./repository-engagement.ts', () => ({
  EngagementForbiddenError: class EngagementForbiddenError extends Error {},
  ingestEngagement: vi.fn(async () => undefined),
  startVisit: vi.fn(async () => ({
    kind: 'started',
    visitId: '22222222-2222-4222-8222-222222222222',
  })),
}));
vi.mock('./repository-viewer-access.ts', () => ({
  ViewerSessionUnavailableError: class ViewerSessionUnavailableError extends Error {},
  getViewerDeck: vi.fn(async () => ({})),
}));

import { ingestEngagement, startVisit } from './repository-engagement.ts';
import { grantViewerAccess, requestAccess } from './repository-sharing.ts';

const shareToken = 'share-token-'.padEnd(32, 'x');
const viewerSession = 'viewer-session-'.padEnd(32, 'x');
const limitedViewerSession = 'limited-viewer-session-'.padEnd(32, 'z');
const secondViewerSession = 'second-viewer-session-'.padEnd(32, 'y');
const visitId = '33333333-3333-4333-8333-333333333333';
let app: Hono<{ Variables: AuthVariables }>;

beforeAll(async () => {
  process.env.RATE_LIMIT_MAX = '10';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.TRUSTED_PROXY_MODE = 'railway';
  const { viewerRoutes } = await import('./routes-viewer.ts');
  app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('user', null);
    c.set('authScopes', null);
    await next();
  });
  app.route('/v1', viewerRoutes);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function post(
  path: string,
  ip: string,
  credential: { readonly name: string; readonly value: string },
  body: unknown,
  forwardedFor?: string,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
      [credential.name]: credential.value,
    },
    body: JSON.stringify(body),
  });
}

async function expectLimited(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(await response.json()).toMatchObject({
    error: 'rate_limited',
    retry_after_seconds: 60,
  });
}

function eventBody(eventCount: number) {
  return {
    events: Array.from({ length: eventCount }, () => ({
      id: '44444444-4444-4444-8444-444444444444',
      eventType: 'heartbeat',
      eventAt: new Date().toISOString(),
      sequence: 1,
      visibleRatio: 1,
      visibleDurationMs: 10_000,
      tabVisible: true,
      recentlyActive: true,
    })),
  };
}

describe('public viewer write rate limits', () => {
  it('shares one per-IP bucket across access and request writes', async () => {
    const credential = { name: 'x-share-token', value: shareToken };
    for (let index = 0; index < 10; index += 1) {
      expect((await post('/v1/share/access', '203.0.113.10', credential, {})).status).toBe(200);
    }
    await expectLimited(
      await post(
        '/v1/share/request',
        '203.0.113.10',
        credential,
        { email: 'viewer@example.com' },
        '198.51.100.99',
      ),
    );
    expect(grantViewerAccess).toHaveBeenCalledTimes(10);
    expect(requestAccess).not.toHaveBeenCalled();

    expect(
      (
        await post('/v1/share/request', '203.0.113.11', credential, {
          email: 'viewer@example.com',
        })
      ).status,
    ).toBe(202);
  });

  it('caps visit creation before repository work', async () => {
    const credential = { name: 'x-viewer-session', value: viewerSession };
    const body = {
      visible: true,
      interacted: true,
      analyticsConsent: true,
      deviceClass: 'desktop',
      browserFamily: 'Chromium',
      countryCode: null,
    };
    for (let index = 0; index < 10; index += 1) {
      expect((await post('/v1/viewer/visits', '203.0.113.20', credential, body)).status).toBe(200);
    }
    await expectLimited(await post('/v1/viewer/visits', '203.0.113.20', credential, body));
    expect(startVisit).toHaveBeenCalledTimes(10);
  });

  it('accepts a full 10-event batch within the event-ingestion limit', async () => {
    const credential = { name: 'x-viewer-session', value: viewerSession };
    const response = await post(
      `/v1/viewer/visits/${visitId}/events`,
      '203.0.113.30',
      credential,
      eventBody(10),
    );
    expect(response.status).toBe(202);
    expect(ingestEngagement).toHaveBeenCalledOnce();
  });

  it('rejects an 11-event batch before repository work', async () => {
    const credential = { name: 'x-viewer-session', value: viewerSession };
    const response = await post(
      `/v1/viewer/visits/${visitId}/events`,
      '203.0.113.31',
      credential,
      eventBody(11),
    );
    expect(response.status).toBe(400);
    expect(ingestEngagement).not.toHaveBeenCalled();
  });

  it('caps each valid viewer session while preserving a shared-IP event ceiling', async () => {
    const firstCredential = { name: 'x-viewer-session', value: limitedViewerSession };
    const secondCredential = { name: 'x-viewer-session', value: secondViewerSession };
    const ip = '203.0.113.40';
    const body = eventBody(1);

    for (let index = 0; index < 30; index += 1) {
      expect(
        (await post(`/v1/viewer/visits/${visitId}/events`, ip, firstCredential, body)).status,
      ).toBe(202);
    }
    await expectLimited(
      await post(`/v1/viewer/visits/${visitId}/events`, ip, firstCredential, body),
    );

    for (let index = 0; index < 9; index += 1) {
      expect(
        (await post(`/v1/viewer/visits/${visitId}/events`, ip, secondCredential, body)).status,
      ).toBe(202);
    }
    await expectLimited(
      await post(`/v1/viewer/visits/${visitId}/events`, ip, secondCredential, body),
    );
    expect(ingestEngagement).toHaveBeenCalledTimes(39);
  });

  it('keeps invalid viewer-session headers in the IP bucket before session limiting', async () => {
    const credential = { name: 'x-viewer-session', value: 'invalid' };
    const body = eventBody(1);
    const ip = '203.0.113.41';

    for (let index = 0; index < 40; index += 1) {
      expect((await post(`/v1/viewer/visits/${visitId}/events`, ip, credential, body)).status).toBe(
        400,
      );
    }
    await expectLimited(await post(`/v1/viewer/visits/${visitId}/events`, ip, credential, body));
    expect(ingestEngagement).not.toHaveBeenCalled();
  });
});
