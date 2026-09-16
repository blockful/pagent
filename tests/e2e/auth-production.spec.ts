import { createHash, randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { z } from 'zod';
import * as db from '../../apps/api/db.ts';
import { SESSION_COOKIE_NAME } from '../../apps/api/auth/middleware.ts';
import { createSession } from '../../apps/api/auth/session.ts';
import { AUTH_TRANSACTION_COOKIE_NAME } from '../../apps/api/auth/route-transaction.ts';
import {
  API_PUBLIC_URL,
  RENDERER_URL,
  connectStdioClient,
  mcpCreatedPageSchema,
  mcpResultSchema,
  signAccessToken,
  startProductionAuthServer,
} from './auth-test-support.ts';

const healthSchema = z.object({ ok: z.literal(true), db: z.literal('ok') });
const errorSchema = z.object({ error: z.string() });
const createdPageSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  url: z.string().url(),
});
const metadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  revocation_endpoint: z.string().url(),
});
const registeredClientSchema = z.object({ client_id: z.string().uuid() });
const jwksSchema = z.object({
  keys: z.array(
    z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), use: z.literal('sig') }),
  ),
});
const resultSchema = z.object({
  state: z.literal('open'),
  result: z.null(),
  format: z.literal('a2ui'),
});
const mcpPresentationSchema = z.object({
  structuredContent: z.object({
    page_id: z.string().uuid(),
    revision_id: z.string().uuid(),
    revision_number: z.number().int().positive(),
    type: z.literal('presentation'),
    durable: z.literal(true),
    manage_url: z.string().url(),
    preview_url: z.string().url(),
  }),
});
const mcpAnalyticsSchema = z.object({
  structuredContent: z.object({
    page_id: z.string().uuid(),
    type: z.literal('presentation'),
    analytics: z.object({
      owner: z.object({ id: z.string().uuid(), email: z.string().email() }),
      overview: z.object({
        totalVisits: z.number().int().nonnegative(),
        uniqueViewers: z.number().int().nonnegative(),
      }),
      visitors: z.array(z.unknown()),
      slides: z.array(z.object({ stableSlideId: z.string() })),
      visits: z.array(z.unknown()),
    }),
  }),
});
const e2eApiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const mcpPresentationTitle = `MCP browser acceptance ${randomUUID()}`;
const mcpPresentationSlideIds = Array.from(
  { length: 10 },
  (_, index) => `mcp-browser-slide-${index + 1}`,
);
test.describe.configure({ mode: 'serial' });

let api: APIRequestContext | undefined;
let stopServer: (() => Promise<void>) | undefined;
let spawnedLocalUrl: string | undefined;
let privateKeyPem: string | undefined;
let user: db.UserRow | undefined;
let createdPageId: string | undefined;
let mcpCreatedPageId: string | undefined;
let mcpPresentationPageId: string | undefined;

async function token(scope: string): Promise<string> {
  if (privateKeyPem === undefined || user === undefined || user.handle === null) {
    throw new TypeError('Production auth E2E fixture is not initialized');
  }
  return signAccessToken(privateKeyPem, {
    userId: user.id,
    email: user.email,
    handle: user.handle,
    scope,
  });
}

async function bearer(scope: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await token(scope)}` };
}

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  try {
    const runId = randomUUID();
    user = await db.upsertUser({
      email: `auth-production-${runId}@example.test`,
      name: 'Production auth E2E',
      avatarUrl: null,
      handle: `auth-e2e-${runId}`,
    });
    const server = await startProductionAuthServer(databaseUrl);
    stopServer = server.stop;
    spawnedLocalUrl = server.localUrl;
    privateKeyPem = server.privateKeyPem;
    api = await request.newContext({ baseURL: server.localUrl });
  } catch (error) {
    try {
      await stopServer?.();
    } finally {
      await db.shutdown();
    }
    throw error;
  }
});

test.afterAll(async () => {
  try {
    await api?.dispose();
  } finally {
    try {
      await stopServer?.();
    } finally {
      await db.shutdown();
    }
  }
});

test('reports a healthy production database connection', async () => {
  const response = await api?.get('/health');
  expect(response?.status()).toBe(200);
  expect(healthSchema.parse(await jsonResponse(response))).toEqual({ ok: true, db: 'ok' });
});

test('rejects anonymous REST page creation', async () => {
  const response = await api?.post('/new', { data: { spec: [] } });
  expect(response?.status()).toBe(401);
  expect(errorSchema.parse(await jsonResponse(response)).error).toBe('unauthorized');
});

test('publishes OAuth metadata on the configured API origin', async () => {
  const response = await api?.get('/.well-known/oauth-authorization-server');
  expect(response?.status()).toBe(200);
  expect(metadataSchema.parse(await jsonResponse(response))).toEqual({
    issuer: API_PUBLIC_URL,
    authorization_endpoint: `${API_PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${API_PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${API_PUBLIC_URL}/oauth/register`,
    revocation_endpoint: `${API_PUBLIC_URL}/oauth/revoke`,
  });
});

test('requires explicit browser-bound consent before exposing OAuth sign-in choices', async ({
  page,
}) => {
  const registration = await api?.post('/oauth/register', {
    data: {
      client_name: 'Production OAuth client',
      redirect_uris: ['https://client.example/callback'],
    },
  });
  expect(registration?.status()).toBe(201);
  const client = registeredClientSchema.parse(await jsonResponse(registration));
  const authorize = new URL('/oauth/authorize', localApiUrl());
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    scope: 'page:create page:read',
    state: 'production-e2e-state',
  }).toString();

  await page.goto(authorize.toString());
  await expect(page.getByText('Unverified OAuth client')).toBeVisible();
  await expect(page.getByText('Production OAuth client')).toBeVisible();
  await expect(page.getByText('https://client.example/callback')).toBeVisible();
  await expect(page.getByText('page:create')).toBeVisible();
  await expect(page.getByText('page:read')).toBeVisible();
  await expect(page.getByRole('link', { name: /Google/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByRole('link', { name: 'Allow and continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow and send magic link' })).toBeVisible();

  await page.goto(authorize.toString());
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Authorization cancelled.')).toBeVisible();
  expect(page.url()).toBe(`${localApiUrl()}/oauth/authorize/consent`);
});

test('rejects an OAuth authorization request without response_type=code', async () => {
  const registration = await api?.post('/oauth/register', {
    data: {
      client_name: 'Invalid response type client',
      redirect_uris: ['https://client.example/callback'],
    },
  });
  expect(registration?.status()).toBe(201);
  const client = registeredClientSchema.parse(await jsonResponse(registration));
  const authorize = new URL('/oauth/authorize', localApiUrl());
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  const response = await api?.get(`${authorize.pathname}${authorize.search}`);

  expect(response?.status()).toBe(400);
  expect(response?.headers()['content-type']).toContain('text/html');
});

test('does not consume a browser-bound magic link when an unbound scanner opens it', async () => {
  const runId = randomUUID();
  const rawToken = `magic-${runId}`;
  const browserTransaction = `browser-${runId}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await db.insertMagicLink({
    email: `magic-production-${runId}@example.test`,
    tokenHash,
    authorizeContext: {
      browserSession: true,
      browserTransactionHash: createHash('sha256').update(browserTransaction).digest('base64url'),
    },
    expiresAt: new Date(Date.now() + 60_000),
  });

  const scanner = await api?.get(`/oauth/magic?token=${rawToken}`);
  expect(scanner?.status()).toBe(400);
  await expect(db.getActiveMagicLink(tokenHash)).resolves.not.toBeNull();

  const browser = await api?.get(`/oauth/magic?token=${rawToken}`, {
    headers: {
      Cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${browserTransaction}`,
    },
    maxRedirects: 0,
  });
  expect(browser?.status()).toBe(302);
  expect(browser?.headers().location).toBe(RENDERER_URL);
  await expect(db.getActiveMagicLink(tokenHash)).resolves.toBeNull();
});

test('publishes the generated Ed25519 public key', async () => {
  const response = await api?.get('/.well-known/jwks.json');
  expect(response?.status()).toBe(200);
  expect(jwksSchema.parse(await jsonResponse(response)).keys).toHaveLength(1);
});

test('rejects anonymous MCP GET with API resource metadata', async () => {
  const response = await api?.get('/mcp');
  expect(response?.status()).toBe(401);
  expect(response?.headers()['www-authenticate']).toContain(
    `${API_PUBLIC_URL}/.well-known/oauth-protected-resource`,
  );
});

test('allows Authorization in MCP CORS preflights', async () => {
  const response = await api?.fetch('/mcp', {
    method: 'OPTIONS',
    headers: {
      Origin: RENDERER_URL,
      'Access-Control-Request-Headers': 'Authorization',
    },
  });
  expect(response?.status()).toBe(204);
  expect(response?.headers()['access-control-allow-headers']).toContain('Authorization');
  expect(response?.headers()['access-control-allow-origin']).toBe(RENDERER_URL);
});

for (const scope of ['', 'page:read']) {
  test(`rejects REST page creation with ${scope || 'empty'} scope`, async () => {
    const response = await api?.post('/new', {
      headers: await bearer(scope),
      data: { spec: [] },
    });
    expect(response?.status()).toBe(403);
    expect(errorSchema.parse(await jsonResponse(response)).error).toBe('insufficient_scope');
  });
}

test('creates a renderer URL with a page:create bearer', async () => {
  const response = await api?.post('/new', {
    headers: await bearer('page:create'),
    data: { spec: [{ createSurface: { surfaceId: 'auth-e2e' } }] },
  });
  expect(response?.status()).toBe(201);
  const created = createdPageSchema.parse(await jsonResponse(response));
  createdPageId = created.id;
  expect(created.url).toBe(`${RENDERER_URL}/${created.id}`);
});

test('rejects result reads with a create-only bearer', async () => {
  const response = await api?.get(`/${pageId()}/result`, {
    headers: await bearer('page:create'),
  });
  expect(response?.status()).toBe(403);
  expect(errorSchema.parse(await jsonResponse(response)).error).toBe('insufficient_scope');
});

test('returns a result with a page:read bearer', async () => {
  const response = await api?.get(`/${pageId()}/result`, {
    headers: await bearer('page:read'),
  });
  expect(response?.status()).toBe(200);
  expect(resultSchema.parse(await jsonResponse(response))).toEqual({
    state: 'open',
    result: null,
    format: 'a2ui',
  });
});

test('stdio MCP surfaces REST 403 when a read-only token calls write', async () => {
  const client = await connectStdioClient(localApiUrl(), await token('page:read'));
  try {
    const result = await client.callTool({
      name: 'write',
      arguments: { type: 'interactive', spec: [] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('write failed (403)');
  } finally {
    await client.close();
  }
});

test('stdio MCP creates a renderer URL with a page:create token', async () => {
  const client = await connectStdioClient(localApiUrl(), await token('page:create'));
  try {
    const result = mcpCreatedPageSchema.parse(
      await client.callTool({
        name: 'write',
        arguments: { type: 'interactive', spec: [] },
      }),
    );
    mcpCreatedPageId = result.structuredContent.page_id;
    expect(result.structuredContent.url).toBe(`${RENDERER_URL}/${mcpCreatedPageId}`);
  } finally {
    await client.close();
  }
});

test('stdio MCP surfaces REST 403 when a create-only token calls read', async () => {
  const client = await connectStdioClient(localApiUrl(), await token('page:create'));
  try {
    const result = await client.callTool({
      name: 'read',
      arguments: { page_id: mcpPageId(), include: 'response' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('read failed (403)');
  } finally {
    await client.close();
  }
});

test('stdio MCP reads a result with a page:read token', async () => {
  const client = await connectStdioClient(localApiUrl(), await token('page:read'));
  try {
    const result = mcpResultSchema.parse(
      await client.callTool({
        name: 'read',
        arguments: { page_id: mcpPageId(), include: 'response' },
      }),
    );
    expect(result.structuredContent).toEqual({
      page_id: mcpPageId(),
      type: 'interactive',
      state: 'open',
      response: null,
    });
  } finally {
    await client.close();
  }
});

test('stdio MCP writes a ten-slide presentation that an authenticated owner can preview without visits', async ({
  page,
}) => {
  const client = await connectStdioClient(localApiUrl(), await token('page:create page:read'));
  try {
    const written = mcpPresentationSchema.parse(
      await client.callTool({
        name: 'write',
        arguments: {
          type: 'presentation',
          title: mcpPresentationTitle,
          slides: mcpPresentationSlideIds.map((id, index) => ({
            id,
            title: `MCP browser slide ${index + 1}`,
            html: `<h1>MCP browser slide ${index + 1}</h1>`,
          })),
        },
      }),
    );
    mcpPresentationPageId = written.structuredContent.page_id;
    expect(written.structuredContent).toMatchObject({
      revision_number: 1,
      type: 'presentation',
      durable: true,
    });

    if (user === undefined) throw new TypeError('Production auth E2E user is not initialized');
    await page
      .context()
      .addCookies([
        { name: SESSION_COOKIE_NAME, value: await createSession(user.id), url: e2eApiUrl },
      ]);
    await page.goto('/pages');
    await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
    await page.getByRole('link', { name: mcpPresentationTitle, exact: true }).click();
    await expect(page.getByText('Slide 1 of 10')).toBeVisible();

    const analytics = mcpAnalyticsSchema.parse(
      await client.callTool({
        name: 'read',
        arguments: { page_id: presentationPageId(), include: 'analytics' },
      }),
    );
    expect(analytics.structuredContent.analytics.owner).toMatchObject({
      id: user.id,
      email: user.email,
    });
    expect(analytics.structuredContent.analytics.overview).toEqual({
      totalVisits: 0,
      uniqueViewers: 0,
    });
    expect(analytics.structuredContent.analytics.visitors).toEqual([]);
    expect(analytics.structuredContent.analytics.visits).toEqual([]);
  } finally {
    await client.close();
  }
});

test('stdio MCP reads analytics for a durable presentation page', async () => {
  const client = await connectStdioClient(localApiUrl(), await token('page:read'));
  try {
    const read = mcpAnalyticsSchema.parse(
      await client.callTool({
        name: 'read',
        arguments: { page_id: presentationPageId(), include: 'analytics' },
      }),
    );
    expect(read.structuredContent).toMatchObject({
      page_id: presentationPageId(),
      type: 'presentation',
      analytics: {
        overview: { totalVisits: 0, uniqueViewers: 0 },
        slides: mcpPresentationSlideIds.map((stableSlideId) => ({ stableSlideId })),
        visitors: [],
        visits: [],
      },
    });
  } finally {
    await client.close();
  }
});

async function jsonResponse(response: APIResponse | undefined): Promise<unknown> {
  if (response === undefined) throw new TypeError('API fixture is not initialized');
  return response.json();
}

function pageId(): string {
  if (createdPageId === undefined) throw new TypeError('Page creation scenario did not run');
  return createdPageId;
}

function mcpPageId(): string {
  if (mcpCreatedPageId === undefined) throw new TypeError('MCP page creation scenario did not run');
  return mcpCreatedPageId;
}

function presentationPageId(): string {
  if (mcpPresentationPageId === undefined) {
    throw new TypeError('MCP presentation creation scenario did not run');
  }
  return mcpPresentationPageId;
}

function localApiUrl(): string {
  if (spawnedLocalUrl === undefined) throw new TypeError('Auth server URL is not initialized');
  return spawnedLocalUrl;
}
