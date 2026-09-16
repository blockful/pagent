import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page, Request } from '@playwright/test';
import { z } from 'zod';
import { SESSION_COOKIE_NAME } from '../../apps/api/auth/middleware.ts';
import { createSession } from '../../apps/api/auth/session.ts';
import * as db from '../../apps/api/db.ts';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const webUrl = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:8788';
const evidenceDir = '.omo/evidence/pagent-v0.1.0-final/e2e';
const title = 'Launch readiness: ten-slide narrative';
const privateSlideCopy = 'Private launch detail ten';
const editedTitle = 'Launch readiness: renamed acceptance proof';
const chosenExpiry = '2099-12-24T18:30';
const ownerEmail = `presentation-owner-${randomUUID()}@example.test`;
const memberEmail = `presentation-member-${randomUUID()}@example.test`;
const allowedEmail = `allowed-${randomUUID()}@example.test`;
const outsiderEmail = `outsider-${randomUUID()}@example.test`;

const publishedSchema = z.object({
  deckId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revisionNumber: z.literal(1),
});
const linkSchema = z.object({ id: z.string().uuid(), token: z.string().min(20) });
const viewerDeckSchema = z.object({
  slides: z.array(z.object({ id: z.string().uuid(), ordinal: z.number().int() })).length(10),
});
const visitSchema = z.object({ kind: z.literal('started'), visitId: z.string().uuid() });
const analyticsSchema = z.object({
  overview: z.object({ totalVisits: z.number().int().nonnegative() }),
});
const engagementEventsSchema = z.object({
  events: z.array(
    z.object({
      eventType: z.enum(['start', 'heartbeat', 'slide_view', 'close']),
      slideId: z.string().uuid().optional(),
    }),
  ),
});

type ShareLink = z.infer<typeof linkSchema>;
type BrowserDiagnostics = {
  readonly assertClean: () => void;
};

test.describe.configure({ mode: 'serial', timeout: 90_000 });

let ownerApi: APIRequestContext | undefined;
let memberApi: APIRequestContext | undefined;
let publicApi: APIRequestContext | undefined;
let ownerSession = '';
let memberSession = '';
let deckId = '';
let anyoneLink: ShareLink | undefined;
let allowedLink: ShareLink | undefined;
let authenticatedLink: ShareLink | undefined;
let revocableLink: ShareLink | undefined;
let expiredLink: ShareLink | undefined;
let allowedViewerSession = '';

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
  await mkdir(evidenceDir, { recursive: true });
  await db.init(databaseUrl);
  const owner = await db.upsertUser({
    email: ownerEmail,
    handle: `presentation-owner-${randomUUID()}`,
    name: 'Presentation Owner',
    avatarUrl: null,
  });
  const member = await db.upsertUser({
    email: memberEmail,
    handle: `presentation-member-${randomUUID()}`,
    name: 'Presentation Member',
    avatarUrl: null,
  });
  ownerSession = await createSession(owner.id);
  memberSession = await createSession(member.id);
  ownerApi = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${ownerSession}` },
  });
  memberApi = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${memberSession}` },
  });
  publicApi = await request.newContext({ baseURL: apiUrl });
});

test.afterAll(async () => {
  await Promise.all([ownerApi?.dispose(), memberApi?.dispose(), publicApi?.dispose()]);
  await db.shutdown();
});

test('owner publishes, discovers, previews, and configures every launch audience', async ({
  page,
}) => {
  const diagnostics = monitor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await shot(page, '16-landing-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await shot(page, '17-landing-mobile.png');
  await page.setViewportSize({ width: 1440, height: 900 });

  const published = publishedSchema.parse(
    await json(
      await owner().post('/v1/decks', {
        data: {
          title,
          description: 'Production-equivalent presentation acceptance fixture',
          client_label: 'Launch acceptance',
          slides: Array.from({ length: 10 }, (_, index) => ({
            id: `launch-${index + 1}`,
            title: `Launch slide ${index + 1}`,
            html: `<article><h1>Launch slide ${index + 1}</h1><p>${index === 9 ? privateSlideCopy : `Narrative ${index + 1}`}</p></article>`,
          })),
        },
      }),
    ),
  );
  deckId = published.deckId;
  expect(
    (
      await owner().post('/v1/workspace/members', { data: { email: memberEmail, role: 'member' } })
    ).status(),
  ).toBe(201);

  await signIn(page.context(), ownerSession);
  await page.goto('/pages');
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await shot(page, '01-owner-pages.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await shot(page, '18-pages-mobile.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByText('Slide 1 of 10')).toBeVisible();

  const titleInput = page.getByLabel('Title');
  await titleInput.fill(editedTitle);
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('heading', { name: editedTitle })).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible();
  await titleInput.fill(title);
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await titleInput.focus();
  await expect(titleInput).toBeFocused();
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, '19-detail-mobile.png', false);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('tab', { name: 'Share links' }).click();
  await page.getByRole('button', { name: 'Create share link' }).click();
  await page.getByLabel('Link name').fill('Anyone launch link');
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/v1/decks/${deckId}/share-links`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save link' }).click();
  anyoneLink = linkSchema.parse(await (await createdResponse).json());
  await expect(page.getByText('Link ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  allowedLink = await createLink('Allowed email launch link', 'allowed_email', [allowedEmail]);
  authenticatedLink = await createLink(
    'Authenticated launch link',
    'authenticated',
    [],
    ['example.test'],
  );
  revocableLink = await createLink('Revocable launch link', 'anyone');
  expiredLink = await createLink('Expired launch link', 'anyone');
  await db.database()`
    update share_links set expires_at = now() - interval '1 minute'
    where id = ${expiredLink.id}
  `;
  await page.reload();
  await page.getByRole('tab', { name: 'Share links' }).click();
  const previewRow = page.getByRole('row').filter({ hasText: 'Anyone launch link' });
  await expect(previewRow).toContainText('Anyone');
  await previewRow.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Expires at').fill(chosenExpiry);
  await page.getByRole('button', { name: 'Save link' }).click();
  await expect(previewRow.locator('[data-label="Expiry"]')).toContainText('2099');
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Expired launch link' })
      .locator('[data-label="Status"]'),
  ).toContainText('expired');
  await previewRow.getByRole('button', { name: 'Preview' }).click();
  await expect(page).toHaveURL(`${webUrl}/view`);
  await expect(page.getByText('Owner preview · not tracked')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Launch slide 1' })).toBeVisible();
  await shot(page, '02-owner-preview.png');
  expect(
    analyticsSchema.parse(await json(await owner().get(`/v1/decks/${deckId}/analytics`))).overview
      .totalVisits,
  ).toBe(0);
  diagnostics.assertClean();
});

test('viewer navigation is responsive and a saved session survives reload', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const diagnostics = monitor(page);
  await page.addInitScript(() => {
    Reflect.set(window, '__fullscreenRequests', 0);
    Element.prototype.requestFullscreen = () => {
      const current = Reflect.get(window, '__fullscreenRequests');
      Reflect.set(window, '__fullscreenRequests', typeof current === 'number' ? current + 1 : 1);
      return Promise.resolve();
    };
  });
  let releaseVisitStart = (): void => undefined;
  const visitStartRelease = new Promise<void>((resolve) => {
    releaseVisitStart = resolve;
  });
  await page.route(/\/v1\/viewer\/visits$/, async (route) => {
    if (route.request().method() === 'POST') await visitStartRelease;
    await route.continue();
  });
  try {
    const link = requiredLink(anyoneLink, 'anyone');
    await page.goto(`/share/${link.token}`);
    await expect(page.getByText('Slide 1 of 10')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fullscreen' })).toBeVisible();
    await scanAccessibility(page, 'viewer-ready-desktop');
    const session = await savedViewerSession(page, link.token);
    const heldVisitRequest = page.waitForRequest(isVisitStartRequest);
    const visitResponse = page.waitForResponse((response) =>
      isVisitStartRequest(response.request()),
    );
    const startEventResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/v1\/viewer\/visits\/[^/]+\/events$/.test(response.url()) &&
        response.request().postData()?.includes('"start"') === true,
    );
    await page.getByRole('button', { name: 'Next →' }).click();
    await heldVisitRequest;
    await expect(page.getByRole('status')).toHaveText('Slide 2 of 10');
    releaseVisitStart();
    const visit = visitSchema.parse(await (await visitResponse).json());
    await startEventResponse;
    await page.getByRole('button', { name: 'Fullscreen' }).click();
    expect(await page.evaluate(() => Reflect.get(window, '__fullscreenRequests'))).toBe(1);
    await page.keyboard.press('End');
    await expect(page.getByRole('status')).toHaveText('Slide 10 of 10');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '← Previous' })).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await shot(page, '03-viewer-desktop.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Home');
    await expect(page.getByRole('status')).toHaveText('Slide 1 of 10');
    for (let expectedSlide = 2; expectedSlide <= 10; expectedSlide += 1) {
      await page.getByRole('button', { name: 'Next →' }).tap();
      await expect(page.getByRole('status')).toHaveText(`Slide ${expectedSlide} of 10`);
    }
    await expect(page.getByRole('button', { name: 'Fullscreen' })).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: '← Previous' })).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await scanAccessibility(page, 'viewer-ready-mobile');
    await shot(page, '04-viewer-mobile.png');

    const viewerDeck = viewerDeckSchema.parse(
      await json(
        await publicRequests().get('/v1/viewer/deck', { headers: { 'x-viewer-session': session } }),
      ),
    );
    await seedJumpEngagement(session, visit.visitId, viewerDeck.slides);
    const closeRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/v1\/viewer\/visits\/[^/]+\/events$/.test(request.url()) &&
        request.postData()?.includes('"close"') === true,
    );
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const closePayload = engagementEventsSchema.parse((await closeRequestPromise).postDataJSON());
    expect(closePayload.events.some((event) => event.eventType === 'close')).toBe(true);
    await page.reload();
    await expect(page.getByText('Slide 1 of 10')).toBeVisible();
    expect(await savedViewerSession(page, link.token)).toBe(session);
    diagnostics.assertClean();
  } finally {
    await context.close();
  }
});

test('email, approval, and authenticated gates enforce their link-specific contracts', async ({
  browser,
  page,
}) => {
  const allowed = requiredLink(allowedLink, 'allowed');
  const allowedContext = await browser.newContext();
  const allowedPage = await allowedContext.newPage();
  const allowedDiagnostics = monitor(allowedPage);
  try {
    await allowedPage.goto(`/share/${allowed.token}`);
    await expect(allowedPage.getByText(/does not verify inbox ownership/i)).toBeVisible();
    await scanAccessibility(allowedPage, 'allowed-email-gate-desktop');
    await allowedPage.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(allowedPage);
    await scanAccessibility(allowedPage, 'allowed-email-gate-mobile');
    await allowedPage.setViewportSize({ width: 1440, height: 900 });
    await allowedPage.getByLabel('Allowed email').fill(allowedEmail);
    await allowedPage.getByRole('button', { name: 'Continue' }).click();
    await expect(allowedPage.getByText('Unverified', { exact: true })).toBeVisible();
    allowedViewerSession = await savedViewerSession(allowedPage, allowed.token);
    await shot(allowedPage, '05-allowed-unverified.png');
    await allowedPage.reload();
    await expect(allowedPage.getByRole('heading', { name: 'Launch slide 1' })).toBeVisible();
    allowedDiagnostics.assertClean();
  } finally {
    await allowedContext.close();
  }

  const requestContext = await browser.newContext();
  const requestPage = await requestContext.newPage();
  const requestDiagnostics = monitor(requestPage);
  try {
    await requestPage.goto(`/share/${allowed.token}`);
    await requestPage.getByLabel('Allowed email').fill(outsiderEmail);
    await requestPage.getByRole('button', { name: 'Continue' }).click();
    await expect(
      requestPage.getByRole('heading', { name: 'Ask the sender for access.' }),
    ).toBeVisible();
    await requestPage.getByLabel('Email for the request').fill(outsiderEmail);
    await requestPage.getByRole('button', { name: 'Request access' }).click();
    await expect(
      requestPage.getByRole('heading', { name: 'The sender is reviewing access.' }),
    ).toBeVisible();
    await shot(requestPage, '06-access-pending.png');

    await signIn(page.context(), ownerSession);
    const ownerDiagnostics = monitor(page);
    await page.goto(`/pages/${deckId}#links`);
    const allowedRow = page.getByRole('row').filter({ hasText: 'Allowed email launch link' });
    await allowedRow.getByRole('button', { name: 'Requests' }).click();
    await expect(page.getByText(outsiderEmail)).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('approved', { exact: true })).toBeVisible();
    ownerDiagnostics.assertClean();

    await requestPage.getByRole('button', { name: 'Check status' }).click();
    await expect(requestPage.getByText('Unverified', { exact: true })).toBeVisible();
    await shot(requestPage, '07-access-approved.png');
    requestDiagnostics.assertClean();
  } finally {
    await requestContext.close();
  }

  const authContext = await browser.newContext();
  const authPage = await authContext.newPage();
  const authDiagnostics = monitor(authPage);
  try {
    await authPage.goto(`/share/${requiredLink(authenticatedLink, 'authenticated').token}`);
    await expect(authPage.getByRole('heading', { name: /Sign in to open/ })).toBeVisible();
    await expect(authPage.getByText(privateSlideCopy)).toHaveCount(0);
    await expect(authPage.getByRole('heading', { name: 'Launch slide 1' })).toHaveCount(0);
    await scanAccessibility(authPage, 'authenticated-gate-desktop');
    await shot(authPage, '08-authenticated-gate.png');
    await authPage.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(authPage);
    await scanAccessibility(authPage, 'authenticated-gate-mobile');
    await shot(authPage, '21-authenticated-gate-mobile.png');
    authDiagnostics.assertClean();
  } finally {
    await authContext.close();
  }

  const expiredContext = await browser.newContext();
  const expiredPage = await expiredContext.newPage();
  const expiredDiagnostics = monitor(expiredPage);
  try {
    await expiredPage.goto(`/share/${requiredLink(expiredLink, 'expired').token}`);
    await expect(
      expiredPage.getByRole('heading', { name: 'This sharing link is expired.' }),
    ).toBeVisible();
    await expect(expiredPage.getByRole('heading', { name: 'Launch slide 1' })).toHaveCount(0);
    expiredDiagnostics.assertClean();
  } finally {
    await expiredContext.close();
  }
});

test('revocation invalidates an already-open browser session on its next fetch', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics = monitor(page, [410]);
  try {
    const link = requiredLink(revocableLink, 'revocable');
    await page.goto(`/share/${link.token}`);
    await expect(page.getByText('Slide 1 of 10')).toBeVisible();
    const session = await savedViewerSession(page, link.token);
    expect((await owner().post(`/v1/decks/${deckId}/share-links/${link.id}/revoke`)).status()).toBe(
      204,
    );
    const denied = await publicRequests().get('/v1/viewer/deck', {
      headers: { 'x-viewer-session': session },
    });
    expect(denied.status()).toBe(410);
    await expect(denied.json()).resolves.toEqual({ error: 'revoked' });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'This sharing link is revoked.' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Launch slide 1' })).toHaveCount(0);
    await shot(page, '09-revoked-link.png');
    diagnostics.assertClean();
  } finally {
    await context.close();
  }
});

test('analytics, permissions, and workspace administration expose only authorized data', async ({
  browser,
  page,
}) => {
  await signIn(page.context(), ownerSession);
  const ownerDiagnostics = monitor(page);
  await page.goto(`/pages/${deckId}#overview`);
  await expect(page.locator('.metric').filter({ hasText: 'Visits' })).toContainText('1');
  await page.getByRole('tab', { name: 'Visitors' }).click();
  await expect(
    page.locator('[role="tabpanel"]:not([hidden])').getByText('Anonymous', { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Slides' }).click();
  await expect(page.getByRole('row').filter({ hasText: '1. Launch slide 1' })).toContainText(
    '100%',
  );
  await expect(page.getByRole('row').filter({ hasText: '10. Launch slide 10' })).toContainText(
    '100%',
  );
  await shot(page, '10-analytics-slides.png');
  ownerDiagnostics.assertClean();

  expect((await member().get(`/v1/decks/${deckId}/analytics`)).status()).toBe(403);
  const memberContext = await browser.newContext();
  await signIn(memberContext, memberSession);
  const memberPage = await memberContext.newPage();
  const memberDiagnostics = monitor(memberPage, [403]);
  try {
    await memberPage.goto(`/pages/${deckId}`);
    await expect(
      memberPage.getByRole('heading', { name: 'You don’t have access to this page.' }),
    ).toBeVisible();
    await expect(memberPage.getByRole('tab', { name: 'Overview' })).toHaveCount(0);
    await expect(memberPage.getByRole('tab', { name: 'Visitors' })).toHaveCount(0);
    await expect(memberPage.getByRole('tab', { name: 'Slides' })).toHaveCount(0);
    await shot(memberPage, '11-member-no-analytics.png');
    memberDiagnostics.assertClean();
  } finally {
    await memberContext.close();
  }

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Presentation pages' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Privacy & retention' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace activity' })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByText(memberEmail, { exact: true })).toBeVisible();
  await expect(page.getByText(privateSlideCopy)).toHaveCount(0);
  await expect(page.getByText('Recent visits')).toHaveCount(0);
  await shot(page, '12-owner-admin.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await shot(page, '20-admin-mobile.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  ownerDiagnostics.assertClean();

  expect((await member().get('/v1/workspace')).status()).toBe(403);
  const forbiddenContext = await browser.newContext();
  await signIn(forbiddenContext, memberSession);
  const forbiddenPage = await forbiddenContext.newPage();
  const forbiddenDiagnostics = monitor(forbiddenPage, [403]);
  try {
    await forbiddenPage.goto('/admin');
    await expect(
      forbiddenPage.getByRole('heading', { name: 'This area is for workspace administrators.' }),
    ).toBeVisible();
    await shot(forbiddenPage, '13-member-admin-forbidden.png');
    forbiddenDiagnostics.assertClean();
  } finally {
    await forbiddenContext.close();
  }
});

test('deletion cancellation preserves the page and final deletion closes every surface', async ({
  page,
}) => {
  await signIn(page.context(), ownerSession);
  const diagnostics = monitor(page, [410]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/pages/${deckId}`);
  const deleteButton = page.getByRole('button', { name: 'Delete', exact: true });
  await deleteButton.click();
  await expect(page.getByRole('heading', { name: `Delete “${title}”?` })).toBeVisible();
  const dialog = page.locator('#delete-dialog');
  const bounds = await dialog.boundingBox();
  if (bounds === null) throw new TypeError('Delete dialog has no viewport bounds');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await expectNoHorizontalOverflow(page);
  await shot(page, '14-delete-confirmation.png', false);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(deleteButton).toBeFocused();
  expect((await owner().get(`/v1/decks/${deckId}/preview`)).status()).toBe(200);

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const deletedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/v1/decks/${deckId}`) && response.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'Delete page' }).click();
  expect((await deletedResponse).status()).toBe(204);
  await expect(page).toHaveURL(`${webUrl}/pages`);
  await expect(page.getByRole('link', { name: title })).toHaveCount(0);

  const viewerUnavailable = await publicRequests().get('/v1/viewer/deck', {
    headers: { 'x-viewer-session': allowedViewerSession },
  });
  expect(viewerUnavailable.status()).toBe(410);
  await expect(viewerUnavailable.json()).resolves.toEqual({ error: 'deleted' });
  expect((await owner().get(`/v1/decks/${deckId}/analytics`)).status()).toBe(403);
  await page.goto(`/share/${requiredLink(allowedLink, 'allowed').token}`);
  await expect(page.getByRole('heading', { name: 'This sharing link is deleted.' })).toBeVisible();
  await expect(page.getByText(privateSlideCopy)).toHaveCount(0);
  await shot(page, '15-deleted-link.png');
  diagnostics.assertClean();
});

async function createLink(
  name: string,
  accessMode: 'anyone' | 'allowed_email' | 'authenticated',
  allowedEmails: readonly string[] = [],
  allowedDomains: readonly string[] = [],
): Promise<ShareLink> {
  const response = await owner().post(`/v1/decks/${deckId}/share-links`, {
    data: {
      name,
      access_mode: accessMode,
      allowed_emails: allowedEmails,
      allowed_domains: allowedDomains,
    },
  });
  expect(response.status()).toBe(201);
  return linkSchema.parse(await response.json());
}

async function seedJumpEngagement(
  sessionToken: string,
  visitId: string,
  slides: readonly { readonly id: string; readonly ordinal: number }[],
): Promise<void> {
  const first = slides.find((slide) => slide.ordinal === 1);
  const last = slides.find((slide) => slide.ordinal === 10);
  if (first === undefined || last === undefined) throw new TypeError('Expected slides one and ten');
  const base = Date.now();
  const response = await publicRequests().post(`/v1/viewer/visits/${visitId}/events`, {
    headers: { 'x-viewer-session': sessionToken },
    data: {
      events: [first, last].map((slide, index) => ({
        id: randomUUID(),
        eventType: 'slide_view',
        slideId: slide.id,
        eventAt: new Date(base + index + 1).toISOString(),
        sequence: index + 100,
        visibleRatio: 1,
        visibleDurationMs: 1_000,
        tabVisible: true,
        recentlyActive: true,
      })),
    },
  });
  expect(response.status()).toBe(202);
}

function monitor(page: Page, allowedHttpStatuses: readonly number[] = []): BrowserDiagnostics {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!allowedHttpStatuses.some((status) => text.includes(String(status)))) errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { assertClean: () => expect(errors).toEqual([]) };
}

async function signIn(context: BrowserContext, session: string): Promise<void> {
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: session, url: apiUrl }]);
}

async function savedViewerSession(page: Page, token: string): Promise<string> {
  const session = await page.evaluate(
    (shareToken) => sessionStorage.getItem(`pagent-viewer-session:${shareToken}`),
    token,
  );
  if (session === null) throw new TypeError('Viewer session was not saved');
  return session;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
}

async function scanAccessibility(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await writeFile(
    `${evidenceDir}/axe-${name}.json`,
    `${JSON.stringify(
      {
        name,
        url: page.url(),
        viewport: page.viewportSize(),
        standards: ['WCAG 2.2 A', 'WCAG 2.2 AA'],
        violationCount: results.violations.length,
        violations: results.violations,
        incomplete: results.incomplete,
      },
      null,
      2,
    )}\n`,
  );
  expect(results.violations).toEqual([]);
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({ path: `${evidenceDir}/${name}`, fullPage, animations: 'disabled' });
}

function isVisitStartRequest(request: Request): boolean {
  return request.method() === 'POST' && /\/v1\/viewer\/visits$/.test(request.url());
}

function owner(): APIRequestContext {
  if (ownerApi === undefined) throw new TypeError('Owner API context is unavailable');
  return ownerApi;
}

function member(): APIRequestContext {
  if (memberApi === undefined) throw new TypeError('Member API context is unavailable');
  return memberApi;
}

function publicRequests(): APIRequestContext {
  if (publicApi === undefined) throw new TypeError('Public API context is unavailable');
  return publicApi;
}

function requiredLink(link: ShareLink | undefined, label: string): ShareLink {
  if (link === undefined) throw new TypeError(`${label} link is unavailable`);
  return link;
}

async function json(response: {
  readonly status: () => number;
  readonly json: () => Promise<unknown>;
}): Promise<unknown> {
  expect(response.status()).toBeGreaterThanOrEqual(200);
  expect(response.status()).toBeLessThan(300);
  return response.json();
}
