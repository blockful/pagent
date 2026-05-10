import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/vendor/**'],
    env: {
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      PORT: '0',
      LOG_LEVEL: 'silent',
    },
    coverage: {
      provider: 'v8',
      include: ['apps/api/**/*.ts', 'apps/mcp/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
    },
  },
});
