import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { createSession } from '../../apps/api/auth/session.ts';
import * as db from '../../apps/api/db.ts';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const evidence = '.omo/evidence/html-document-decks/browser';
let ownerApi: APIRequestContext;

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  await db.init(z.string().url().parse(process.env.DATABASE_URL));
  const user = await db.upsertUser({
    email: `html-loading-${randomUUID()}@example.test`,
    handle: `loading-${randomUUID()}`,
    name: 'HTML Loading Owner',
    avatarUrl: null,
  });
  const session = await createSession(user.id);
  ownerApi = await request.newContext({
    baseURL: apiUrl,
    extraHTTPHeaders: { Cookie: `pagent_session=${session}` },
  });
});

test.afterAll(async () => {
  await ownerApi?.dispose();
  await db.shutdown();
});

async function publish(html: string) {
  const response = await ownerApi.post('/v1/decks', {
    data: { title: 'Author HTML policy', html },
  });
  expect(response.status()).toBe(201);
  const { deckId } = z.object({ deckId: z.string().uuid() }).parse(await response.json());
  const link = await ownerApi.post(`/v1/decks/${deckId}/share-links`, {
    data: { name: 'Author policy', access_mode: 'anyone' },
  });
  expect(link.status()).toBe(201);
  return {
    deckId,
    ...z.object({ id: z.string().uuid(), token: z.string() }).parse(await link.json()),
  };
}

test('author CSP may block telemetry without blocking authored HTML or JavaScript', async ({
  page,
}) => {
  const link = await publish(`<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="script-src 'nonce-demo'">
    </head><body><h1>Author policy works</h1><button id="go">Run authored JavaScript</button>
    <script nonce="demo">document.getElementById('go').onclick=()=>document.querySelector('h1').textContent='Author script ran';</script>
    </body></html>`);
  await page.goto(`/share/${link.token}`);
  const frame = page.frameLocator('document-frame iframe');
  await frame.getByRole('button', { name: 'Run authored JavaScript' }).click();
  await expect(frame.getByRole('heading', { name: 'Author script ran' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Opening page…', { exact: true })).toHaveCount(0);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${evidence}/author-policy-${width}.png` });
  }
});

test('a document consuming the appended script as raw text still remains visible', async ({
  page,
}) => {
  const link = await publish(
    '<!doctype html><h1>Raw text document</h1><textarea aria-label="Author notes">Notes',
  );
  await page.goto(`/share/${link.token}`);
  const frame = page.frameLocator('document-frame iframe');
  await frame.getByRole('textbox', { name: 'Author notes' }).fill('Still editable');
  await expect(frame.getByRole('textbox', { name: 'Author notes' })).toHaveValue('Still editable');
  await expect(page.getByText('Opening page…', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('access lost between metadata and document delivery shows a recoverable error', async ({
  page,
}) => {
  const link = await publish('<!doctype html><h1>Revoked document</h1>');
  await page.route(
    `${apiUrl}/v1/viewer/document`,
    async (route) => {
      expect(
        (await ownerApi.post(`/v1/decks/${link.deckId}/share-links/${link.id}/revoke`)).status(),
      ).toBe(204);
      await route.continue();
    },
    { times: 1 },
  );
  await page.goto(`/share/${link.token}`);
  await expect(page.getByRole('alert')).toContainText('could not be opened');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${evidence}/document-error-${width}.png` });
  }
});
