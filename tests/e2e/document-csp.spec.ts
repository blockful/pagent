import { expect, test } from '@playwright/test';
import { buildCsp } from '../../apps/web/csp.ts';

test('a prefixed API document POST is allowed by the real browser CSP', async ({ page }) => {
  const apiBase = 'https://api.example.test/prefix';
  let documentMethod: string | undefined;
  await page.route('https://renderer.example.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<meta http-equiv="Content-Security-Policy" content="${buildCsp(apiBase)}">
        <iframe name="document" sandbox="allow-scripts"></iframe>
        <form method="post" target="document" action="${apiBase}/v1/viewer/document">
          <button>Open document</button>
        </form>`,
    }),
  );
  await page.route(`${apiBase}/v1/viewer/document`, (route) => {
    documentMethod = route.request().method();
    return route.fulfill({
      contentType: 'text/html',
      body: '<h1>Prefixed document</h1>',
    });
  });

  await page.goto('https://renderer.example.test/');
  await page.getByRole('button', { name: 'Open document' }).click();

  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'Prefixed document' }),
  ).toBeVisible();
  expect(documentMethod).toBe('POST');
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
});
