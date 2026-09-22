import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { createSession } from '../../apps/api/auth/session.ts';
import * as db from '../../apps/api/db.ts';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const webUrl = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:8788';
const evidence = '.omo/evidence/html-document-decks/browser';
const publishedSchema = z.object({ deckId: z.string().uuid(), revisionId: z.string().uuid() });
const linkSchema = z.object({ id: z.string().uuid(), token: z.string() });
const analyticsSchema = z.object({
  contentFormat: z.literal('html'),
  overview: z.object({
    totalVisits: z.number(),
    averageActiveTimeMs: z.number(),
    averageCompletion: z.null(),
    topSlide: z.null(),
  }),
  slides: z.array(z.unknown()).length(0),
  visits: z.array(
    z.object({ totalActiveTimeMs: z.number(), completion: z.null(), viewedSlides: z.null() }),
  ),
});
let ownerApi: APIRequestContext;
let session = '';
let deckId = '';
let shareToken = '';
let shareId = '';
let source = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await db.init(databaseUrl);
  const user = await db.upsertUser({
    email: `html-owner-${randomUUID()}@example.test`,
    handle: `html-${randomUUID()}`,
    name: 'HTML Owner',
    avatarUrl: null,
  });
  session = await createSession(user.id);
  ownerApi = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: { Cookie: `pagent_session=${session}` },
  });
  source = await readFile(new URL('../fixtures/authored-deck.html', import.meta.url), 'utf8');
  const response = await ownerApi.post('/v1/decks', {
    data: { title: 'Independent Studio', html: source },
  });
  expect(response.status()).toBe(201);
  const published = publishedSchema.parse(await response.json());
  deckId = published.deckId;
  const link = linkSchema.parse(
    await (
      await ownerApi.post(`/v1/decks/${deckId}/share-links`, {
        data: { name: 'HTML audience', access_mode: 'anyone' },
      })
    ).json(),
  );
  shareToken = link.token;
  shareId = link.id;
});

test.afterAll(async () => {
  await ownerApi?.dispose();
  await db.shutdown();
});

test('owner previews the submitted document without creating a visit', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'pagent_session', value: session, url: apiUrl, sameSite: 'Lax' },
  ]);
  const preview = await ownerApi.get(`/v1/decks/${deckId}/preview`);
  expect(await preview.json()).toMatchObject({ html: source, slides: [] });
  await page.goto(`/pages/${deckId}#preview`);
  const frame = page.frameLocator('document-frame iframe');
  await expect(frame.getByRole('heading', { name: 'Your story. Your HTML.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Next chapter' }).click();
  await expect(frame.getByRole('heading', { name: 'Built to move.' })).toBeVisible();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${evidence}/owner-${width}.png`, fullPage: true });
  }
  const analytics = analyticsSchema.parse(
    await (await ownerApi.get(`/v1/decks/${deckId}/analytics`)).json(),
  );
  expect(analytics.overview.totalVisits).toBe(0);
});

test('authored document owns its viewport, navigation, and page engagement', async ({ page }) => {
  await page.setContent(source);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Opening chapter' }).click();
    await page.screenshot({ path: `${evidence}/reference-opening-${width}.png` });
    await page.getByRole('button', { name: 'Next chapter' }).click();
    await page.screenshot({ path: `${evidence}/reference-details-${width}.png` });
  }
  await page.goto(`/share/${shareToken}`);
  const frame = page.frameLocator('document-frame iframe');
  await expect(frame.getByRole('heading', { name: 'Your story. Your HTML.' })).toBeVisible();
  await expect(page.locator('.viewer-controls')).toHaveCount(0);
  await expect(page.locator('.slide-canvas')).toHaveCount(0);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await frame.getByRole('button', { name: 'Opening chapter' }).click();
    await page.screenshot({ path: `${evidence}/viewer-opening-${width}.png` });
    await frame.getByRole('button', { name: 'Next chapter' }).click();
    await expect(frame.getByRole('heading', { name: 'Built to move.' })).toBeVisible();
    await page.screenshot({ path: `${evidence}/viewer-details-${width}.png` });
    const bounds = await page.locator('document-frame iframe').boundingBox();
    expect(bounds).toMatchObject({ x: 0, y: 0, width, height: 900 });
  }
  await frame.getByRole('button', { name: 'Next chapter' }).press('ArrowLeft');
  await expect(frame.getByRole('heading', { name: 'Your story. Your HTML.' })).toBeVisible();
  await expect
    .poll(
      async () => {
        const result = analyticsSchema.parse(
          await (await ownerApi.get(`/v1/decks/${deckId}/analytics`)).json(),
        );
        return result.overview.averageActiveTimeMs;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
});

test('sandbox denies account access, external requests, and top navigation', async ({ page }) => {
  const escapedRequests: string[] = [];
  await page.route('https://example.com/**', async (route) => {
    escapedRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto(`/share/${shareToken}`);
  const frame = page.frameLocator('document-frame iframe');
  await expect(frame.getByRole('button', { name: 'Next chapter' })).toBeVisible();
  const escaped = await frame.locator('body').evaluate(async () => {
    const attempt = (run: () => unknown): boolean => {
      try {
        run();
        return true;
      } catch {
        return false;
      }
    };
    const parentAccess = attempt(() => window.parent.document.body);
    const cookieAccess = attempt(() => document.cookie);
    const storageAccess = attempt(() => localStorage.getItem('pagent_session'));
    const topNavigation = attempt(() => {
      window.top?.location.assign('https://example.com/escape');
    });
    const popup = window.open('https://example.com/escape');
    const worker = attempt(() => new Worker('https://example.com/worker'));
    const form = document.createElement('form');
    form.action = 'https://example.com/form';
    form.method = 'POST';
    document.body.append(form);
    form.submit();
    const image = new Image();
    image.src = 'https://example.com/image';
    document.body.append(image);
    const child = document.createElement('iframe');
    child.src = 'https://example.com/frame';
    document.body.append(child);
    let network = true;
    try {
      await fetch('https://example.com/private-data');
    } catch {
      network = false;
    }
    return {
      parentAccess,
      cookieAccess,
      storageAccess,
      topNavigation,
      popup: popup !== null,
      worker,
      network,
    };
  });
  expect(escaped).toEqual({
    parentAccess: false,
    cookieAccess: false,
    storageAccess: false,
    topNavigation: false,
    popup: false,
    worker: false,
    network: false,
  });
  expect(page.url()).toBe(`${webUrl}/share/${shareToken}`);
  await expect(frame.getByRole('button', { name: 'Next chapter' })).toBeVisible();
  expect(escapedRequests).toEqual([]);
});

for (const method of ['script', 'link', 'refresh']) {
  test(`sandbox blocks external self-navigation via ${method}`, async ({ page }) => {
    const escapedRequests: string[] = [];
    await page.route('https://example.com/**', async (route) => {
      escapedRequests.push(route.request().url());
      await route.abort();
    });
    await page.goto(`/share/${shareToken}`);
    const frame = page.frameLocator('document-frame iframe');
    await expect(frame.getByRole('button', { name: 'Next chapter' })).toBeVisible();
    const blocked = page.waitForEvent('framenavigated', {
      predicate: (candidate) => candidate.url() === 'chrome-error://chromewebdata/',
    });
    await frame.locator('body').evaluate((_, navigation) => {
      const url = 'https://example.com/escape';
      if (navigation === 'script') location.assign(url);
      else if (navigation === 'link') {
        const link = document.createElement('a');
        link.href = url;
        document.body.append(link);
        link.click();
      } else {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'refresh';
        meta.content = `0;url=${url}`;
        document.head.append(meta);
      }
    }, method);
    await blocked;
    expect(escapedRequests).toEqual([]);
    expect(page.url()).toBe(`${webUrl}/share/${shareToken}`);
  });
}

test('HTML analytics stays usable without invented slide completion, and revocation blocks reopening', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'pagent_session', value: session, url: apiUrl, sameSite: 'Lax' },
  ]);
  await page.goto(`/pages/${deckId}#overview`);
  await expect(page.getByRole('tab', { name: 'Slides', exact: true })).toHaveCount(0);
  await expect(page.getByText('Average completion', { exact: true })).toHaveCount(0);
  for (const tab of ['Overview', 'Visitors']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `${evidence}/analytics-${tab.toLowerCase()}-${width}.png`,
        fullPage: true,
      });
    }
  }
  expect((await ownerApi.post(`/v1/decks/${deckId}/share-links/${shareId}/revoke`)).status()).toBe(
    204,
  );
  await page.goto(`/share/${shareToken}`);
  await expect(page.getByRole('heading', { name: /revoked/i })).toBeVisible();
  await expect(page.locator('document-frame')).toHaveCount(0);
});
