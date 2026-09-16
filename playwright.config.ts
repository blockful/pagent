import { defineConfig, devices } from '@playwright/test';
import { z } from 'zod';

const databaseUrl = z.string().url().parse(process.env.DATABASE_URL);
const apiUrl = 'http://127.0.0.1:8787';
const webUrl = 'http://127.0.0.1:8788';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run start:api',
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: databaseUrl,
        PORT: '8787',
        PUBLIC_URL: webUrl,
        ALLOWED_ORIGINS: webUrl,
        NODE_ENV: 'test',
        REQUIRE_AUTH: 'false',
        LOG_LEVEL: 'silent',
      },
    },
    {
      command:
        'npm run build:web && npm -w @pagent/web run preview -- --host 127.0.0.1 --port 8788 --strictPort',
      url: webUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_URL: apiUrl },
    },
  ],
});
