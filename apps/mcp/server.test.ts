import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { formatRetryHint } from './lib.ts';

describe('stdio MCP contract', () => {
  it('exposes exactly the read and write tools', async () => {
    const client = new Client({ name: 'pagent-stdio-test', version: '0.0.1' });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['apps/mcp/server.bundle.js'],
          cwd: process.cwd(),
          env: getDefaultEnvironment(),
          stderr: 'pipe',
        }),
      );

      const tools = await client.listTools();

      expect(tools.tools.map(({ name }) => name).sort()).toEqual(['read', 'write']);
      expect(tools.tools.find(({ name }) => name === 'write')?.inputSchema).toMatchObject({
        type: 'object',
        required: ['type'],
        properties: {
          type: { enum: ['interactive', 'document', 'presentation'] },
          html: { type: 'string' },
          title: { type: 'string' },
          spec: { type: 'array' },
          page_id: { type: 'string', format: 'uuid' },
        },
      });
    } finally {
      await client.close();
    }
  });
});

describe('formatRetryHint', () => {
  it('returns empty string for an empty body', () => {
    expect(formatRetryHint({})).toBe('');
  });

  it('returns retry hint when retry_after_seconds is present', () => {
    expect(formatRetryHint({ retry_after_seconds: 60 })).toBe('Retry after 60s');
  });

  it('returns size hint when max_bytes is present', () => {
    expect(formatRetryHint({ max_bytes: 262144 })).toBe('Reduce body to ≤262144 bytes');
  });

  it('prefers retry_after_seconds over max_bytes when both are present', () => {
    expect(formatRetryHint({ retry_after_seconds: 30, max_bytes: 262144 })).toBe('Retry after 30s');
  });
});
