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
      TRUSTED_PROXY_MODE: 'railway',
    },
    coverage: {
      provider: 'v8',
      include: ['apps/api/**/*.ts', 'apps/mcp/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/dist/**',
        'apps/api/server.ts',
        'apps/api/tracing.ts',
        'apps/mcp/server.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
