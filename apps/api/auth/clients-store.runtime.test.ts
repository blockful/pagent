import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('auth production runtime', () => {
  it('loads auth modules under the strip-types launcher used by the API', () => {
    // Given the exact Node TypeScript mode used by the production start script.
    const command = [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      "await Promise.all([import('./apps/api/auth/clients-store.ts'), import('./apps/api/auth/provider.ts')])",
    ];

    // When the OAuth client store is loaded without a transpiler.
    const result = spawnSync(process.execPath, command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
        NODE_ENV: 'test',
      },
    });

    // Then the module must contain only erasable TypeScript syntax.
    expect(result.status, result.stderr).toBe(0);
  });
});
