/**
 * HTTP MCP request handler.
 *
 * Wires the shared pagent tool definitions to MCP's StreamableHTTPServerTransport
 * in stateless mode: each request gets a fresh server instance. Pagent has no
 * per-MCP-session state (the page_id is the durable handle), so statelessness
 * is the simpler choice and avoids any session bookkeeping.
 *
 * Because the SDK transport writes directly to the underlying Node response
 * stream, this handler bypasses Hono entirely and re-implements the few
 * pieces of middleware the REST side gets for free: request-id propagation,
 * access logging on `res.on('finish')`, a couple of security headers, and
 * a permissive CORS shape that mirrors the REST CORS policy.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { MAX_BODY_BYTES } from '../app.ts';
import { clientKey } from '../client-key.ts';
import { env } from '../schemas.ts';
import * as store from '../store.ts';
import { getDeckAnalytics } from '../decks/repository-analytics.ts';
import { publishDeck } from '../decks/repository-decks.ts';
import { logger } from '../logger.ts';
import { verifyAccessToken } from '../auth/jwt.ts';
import { RateLimiter } from './rate-limit.ts';
import { registerPagentTools, type PageOps } from './tools.ts';
import type { McpHttpConfig } from './http-config.ts';
import {
  applyBaseHeaders,
  applyCorsPreflightHeaders,
  getOrCreateRequestId,
  readJsonBody,
  respondJson,
} from './http-wire.ts';

declare module 'node:http' {
  interface IncomingMessage {
    auth?: AuthInfo;
  }
}

export type { McpHttpConfig } from './http-config.ts';

export function buildInProcessOps(cfg: McpHttpConfig): PageOps {
  return {
    async writePresentation(input, publisher) {
      if (publisher === undefined) throw new TypeError('Authentication required for durable pages');
      const published = await publishDeck(publisher, input);
      const base = cfg.publicUrl.replace(/\/$/, '');
      return {
        page_id: published.deckId,
        revision_id: published.revisionId,
        revision_number: published.revisionNumber,
        manage_url: `${base}/pages/${published.deckId}`,
        preview_url: `${base}/pages/${published.deckId}#preview`,
      };
    },
    async writeInteractive(spec, ownerId) {
      // ownerId arrives from the SDK's RequestHandlerExtra.authInfo.extra.sub
      // (set by the Bearer middleware below). Forwarded unchanged into the
      // store so pages created via authenticated MCP carry the right
      // owner_id. Anonymous MCP calls (REQUIRE_AUTH=false) leave ownerId
      // undefined, which createPage turns into SQL NULL.
      return store.createPage(spec, 'a2ui', {
        publicUrl: cfg.publicUrl,
        pageTtlMs: cfg.pageTtlMs,
        ownerId,
      });
    },
    async writeDocument(html, ownerId) {
      // No request context here — log at the module logger level. The REST
      // POST /new path passes a request-scoped child logger; this is the MCP
      // path. store.createHtmlPage handles sanitize+log+store in one ritual
      // and throws SanitizedEmptyError if the input was stripped to empty —
      // the MCP transport surfaces the throw to the client as an error.
      return store.createHtmlPage(
        html,
        {
          publicUrl: cfg.publicUrl,
          pageTtlMs: cfg.pageTtlMs,
          ownerId,
        },
        logger,
      );
    },
    async readResponse(pageId) {
      return store.advanceResult(pageId);
    },
    async readAnalytics(pageId, readerId) {
      if (readerId === undefined) throw new TypeError('Authentication required for analytics');
      return getDeckAnalytics(readerId, pageId, {});
    },
  };
}

export function makeMcpHttpHandler(cfg: McpHttpConfig) {
  const ops = buildInProcessOps(cfg);
  const maxBytes = cfg.maxBodyBytes ?? MAX_BODY_BYTES;
  const limiter = cfg.rateLimiter ?? new RateLimiter(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_MS);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = getOrCreateRequestId(req);
    const log = logger.child({ req_id: requestId });
    const start = Date.now();
    applyBaseHeaders(req, res, requestId);

    // Access log on response completion — mirrors the Hono middleware in app.ts.
    res.on('finish', () => {
      log.info(
        {
          method: req.method,
          path: req.url?.split('?', 1)[0],
          status: res.statusCode,
          duration_ms: Date.now() - start,
        },
        'request',
      );
    });

    // CORS preflight: handled here, never reaches the SDK transport.
    if (req.method === 'OPTIONS') {
      applyCorsPreflightHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    // Rate limit: only counts POSTs (the only method that does meaningful
    // work in stateless mode). Mirrors REST's per-IP limiter on POST /new
    // but uses a separate bucket — see rate-limit.ts for the trade-off.
    // Headers follow IETF draft-7 (combined `RateLimit` + `RateLimit-Policy`)
    // to match what hono-rate-limiter emits on the REST side.
    if (req.method === 'POST') {
      const result = limiter.check(clientKey(req.headers['x-real-ip']));
      res.setHeader(
        'RateLimit',
        `limit=${result.limit}, remaining=${result.remaining}, reset=${result.secondsUntilReset}`,
      );
      res.setHeader('RateLimit-Policy', `${result.limit};w=${limiter.windowSeconds()}`);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.secondsUntilReset));
        respondJson(res, 429, {
          error: 'rate_limited',
          retry_after_seconds: result.secondsUntilReset,
          message: `Too many requests; retry after ${result.secondsUntilReset} seconds`,
          request_id: requestId,
        });
        return;
      }
    }

    // Bearer auth — gated on REQUIRE_AUTH. On a 401 we surface the
    // resource_metadata URL via WWW-Authenticate per RFC 9728 so MCP clients
    // can discover the AS without an out-of-band config step. The check sits
    // after rate-limit (no point validating tokens we'd throttle anyway) but
    // before body parse (a 401 should be cheap and not trigger body reads).
    if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
      const authHeader = req.headers.authorization;
      const resourceMetadataUrl = `${cfg.apiPublicUrl}/.well-known/oauth-protected-resource`;
      if (!authHeader?.startsWith('Bearer ')) {
        if (env.REQUIRE_AUTH) {
          res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
          respondJson(res, 401, {
            error: 'unauthorized',
            message: 'Bearer token required',
            request_id: requestId,
          });
          return;
        }
      } else {
        const token = authHeader.slice('Bearer '.length).trim();
        try {
          const claims = await verifyAccessToken(token);
          req.auth = {
            token,
            clientId: claims.client_id,
            scopes: claims.scope.split(/\s+/).filter(Boolean),
            expiresAt: claims.exp,
            extra: { sub: claims.sub, email: claims.email, handle: claims.handle },
          };
        } catch {
          res.setHeader(
            'WWW-Authenticate',
            `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
          );
          respondJson(res, 401, {
            error: 'invalid_token',
            message: 'Invalid or expired access token',
            request_id: requestId,
          });
          return;
        }
      }
    }

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req, maxBytes);
      } catch (err) {
        respondJson(res, 400, {
          error: 'bad_request',
          message: err instanceof Error ? err.message : 'failed to parse body',
          request_id: requestId,
        });
        return;
      }
    }

    // Stateless: fresh server + transport per request. The page_id is the
    // durable handle, so MCP-session state is unused.
    const server = new McpServer({ name: 'pagent', version: '0.1.0' });
    registerPagentTools(server, ops);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error(
        { err, method: req.method, path: req.url?.split('?', 1)[0] },
        'mcp http request failed',
      );
      if (!res.headersSent) {
        respondJson(res, 500, {
          error: 'internal_error',
          message: 'MCP request failed',
          request_id: requestId,
        });
      } else {
        res.end();
      }
    }
  };
}
