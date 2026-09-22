import { randomUUID } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { z } from 'zod';
import { SESSION_COOKIE_NAME } from '../../apps/api/auth/middleware.ts';
import { createSession } from '../../apps/api/auth/session.ts';
import * as db from '../../apps/api/db.ts';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const publishedSchema = z.object({ deckId: z.string().uuid() });
const linkSchema = z.object({ token: z.string() });
const visitSchema = z.object({ kind: z.literal('started'), visitId: z.string().uuid() });
const analyticsSchema = z.object({
  visits: z.array(
    z.object({
      id: z.string(),
      lastSlide: z.number().nullable(),
      completion: z.number(),
      slideSequence: z.array(z.object({ ordinal: z.number(), activeDurationMs: z.number() })),
    }),
  ),
  slides: z.array(
    z.object({ ordinal: z.number(), totalActiveTimeMs: z.number(), exits: z.number() }),
  ),
});

let ownerApi: APIRequestContext;
let ownerSession: string;

test.beforeAll(async () => {
  await db.init(z.string().url().parse(process.env.DATABASE_URL));
  const owner = await db.upsertUser({
    email: `engagement-readiness-${randomUUID()}@example.test`,
    handle: `engagement-readiness-${randomUUID()}`,
    name: 'Analytics readiness',
    avatarUrl: null,
  });
  ownerSession = await createSession(owner.id);
  ownerApi = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${ownerSession}` },
  });
});

test.afterAll(async () => {
  await ownerApi?.dispose();
  await db.shutdown();
});

async function presentation(): Promise<{ readonly deckId: string; readonly token: string }> {
  const response = await ownerApi.post('/v1/decks', {
    data: {
      title: 'Engagement readiness',
      slides: [1, 2, 3].map((ordinal) => ({
        id: `readiness-${ordinal}`,
        title: `Slide ${ordinal}`,
        html: `<article><h1>Slide ${ordinal}</h1><p>Readiness narrative</p></article>`,
      })),
    },
  });
  expect(response.status()).toBe(201);
  const { deckId } = publishedSchema.parse(await response.json());
  const link = await ownerApi.post(`/v1/decks/${deckId}/share-links`, {
    data: {
      name: 'Anyone readiness',
      access_mode: 'anyone',
      allowed_emails: [],
      allowed_domains: [],
    },
  });
  expect(link.status()).toBe(201);
  return { deckId, ...linkSchema.parse(await link.json()) };
}

function qualifyingResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/v1\/viewer\/visits\/[^/]+\/events$/.test(response.url()) &&
      response.request().postData()?.includes('"slide_view"') === true,
  );
}

test('reading and revisiting slides preserves dwell, actual sequence, and drop-off in the owner UI', async ({
  browser,
}) => {
  const fixture = await presentation();
  const viewer = await browser.newContext();
  const owner = await browser.newContext();
  try {
    const page = await viewer.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`/share/${fixture.token}`);
    await expect(page.getByRole('status')).toHaveText('Slide 1 of 3');
    const first = qualifyingResponse(page);
    await page.keyboard.press('Home');
    expect((await first).status()).toBe(202);
    // Measured reading dwell, not a wait for asynchronous readiness.
    await page.waitForTimeout(6000);
    const second = qualifyingResponse(page);
    await page.getByRole('button', { name: 'Next →' }).click();
    expect((await second).status()).toBe(202);
    const beforeReturn = analyticsSchema.parse(
      await (await ownerApi.get(`/v1/decks/${fixture.deckId}/analytics`)).json(),
    );
    expect(
      beforeReturn.slides.find((slide) => slide.ordinal === 1)?.totalActiveTimeMs,
    ).toBeGreaterThan(
      beforeReturn.slides.find((slide) => slide.ordinal === 2)?.totalActiveTimeMs ?? Infinity,
    );
    const returned = qualifyingResponse(page);
    await page.getByRole('button', { name: '← Previous' }).click();
    expect((await returned).status()).toBe(202);
    const result = analyticsSchema.parse(
      await (await ownerApi.get(`/v1/decks/${fixture.deckId}/analytics`)).json(),
    );
    const visit = result.visits[0];
    expect(visit?.lastSlide).toBe(1);
    expect(visit?.slideSequence.map((slide) => slide.ordinal)).toEqual([1, 2, 1]);
    expect(visit?.completion).toBeCloseTo(2 / 3);
    expect(result.slides.find((slide) => slide.ordinal === 1)?.exits).toBe(1);
    expect(result.slides.find((slide) => slide.ordinal === 2)?.exits).toBe(0);
    await owner.addCookies([{ name: SESSION_COOKIE_NAME, value: ownerSession, url: apiUrl }]);
    const ownerPage = await owner.newPage();
    await ownerPage.goto(`/pages/${fixture.deckId}#overview`);
    await expect(ownerPage.getByText('1 → 2 → 1', { exact: true })).toBeVisible();
    await expect(ownerPage.locator('td[data-label="Last"]')).toHaveText('1');
    const times = ownerPage.locator('details');
    await times.getByText('Time by slide', { exact: true }).focus();
    await ownerPage.keyboard.press('Enter');
    await expect(times).toHaveAttribute('open', '');
    await expect(times.locator('li')).toHaveCount(3);
    await expect(times.locator('li').first()).toContainText('Slide 1 · Slide 1:');
    await expect(times.locator('li').nth(1)).toContainText('Slide 2 · Slide 2:');
    await expect(times.locator('li').last()).toContainText('Slide 1 · Slide 1:');
    expect(pageErrors).toEqual([]);
  } finally {
    await viewer.close();
    await owner.close();
  }
});

test('a same-tab return after thirty minutes starts a new visit without blocking navigation', async ({
  page,
}) => {
  const fixture = await presentation();
  await page.clock.install({ time: new Date() });
  await page.goto(`/share/${fixture.token}`);
  await expect(page.getByRole('status')).toHaveText('Slide 1 of 3');
  const startedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/v1/viewer/visits'),
  );
  await page.keyboard.press('Home');
  const started = visitSchema.parse(await (await startedResponse).json());
  const qualified = qualifyingResponse(page);
  await page.clock.runFor(1100);
  await qualified;
  await db.database()`update visits set last_activity_at = now() - interval '31 minutes' where id = ${started.visitId}`;
  await page.clock.fastForward(31 * 60_000);
  const resumedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/v1/viewer/visits'),
  );
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.getByRole('status')).toHaveText('Slide 2 of 3');
  const resumed = visitSchema.parse(await (await resumedResponse).json());
  expect(resumed.visitId).not.toBe(started.visitId);
  const result = analyticsSchema.parse(
    await (await ownerApi.get(`/v1/decks/${fixture.deckId}/analytics`)).json(),
  );
  expect(result.visits).toHaveLength(2);
});
