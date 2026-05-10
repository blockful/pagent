/**
 * HTTP MCP request handler.
 *
 * Wires the shared pagent tool definitions to MCP's StreamableHTTPServerTransport
 * in stateless mode: each request gets a fresh server instance. Pagent has no
 * per-MCP-session state (the page_id is the durable handle), so statelessness
 * is the simpler choice and avoids any session bookkeeping.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as store from '../store.ts';
import { logger } from '../logger.ts';
import { registerPagentTools, type PageOps } from './tools.ts';

export type McpHttpConfig = {
  publicUrl: string;
  pageTtlMs: number;
  /** Cap for request bodies; matches Hono's bodyLimit on the REST side. */
  maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export function buildInProcessOps(cfg: McpHttpConfig): PageOps {
  return {
    async showUi(spec) {
      return store.createPage(spec, {
        publicUrl: cfg.publicUrl,
        pageTtlMs: cfg.pageTtlMs,
      });
    },
    async checkResult(page_id) {
      return store.advanceResult(page_id);
    },
  };
}

export function makeMcpHttpHandler(cfg: McpHttpConfig) {
  const ops = buildInProcessOps(cfg);
  const maxBytes = cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req, maxBytes);
      } catch (err) {
        respondJson(res, 400, {
          error: 'bad_request',
          message: err instanceof Error ? err.message : 'failed to parse body',
        });
        return;
      }
    }

    // Stateless: fresh server + transport per request. The page_id is the
    // durable handle, so MCP-session state is unused.
    const server = new McpServer({ name: 'pagent', version: '0.0.1' });
    registerPagentTools(server, ops);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error({ err }, 'mcp http request failed');
      if (!res.headersSent) {
        respondJson(res, 500, {
          error: 'internal_error',
          message: 'MCP request failed',
        });
      } else {
        res.end();
      }
    }
  };
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error(`request body exceeds the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}
