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
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MAX_BODY_BYTES, ALLOWED_ORIGINS } from '../app.ts';
import { clientKey } from '../client-key.ts';
import { env } from '../schemas.ts';
import * as store from '../store.ts';
import { logger } from '../logger.ts';
import { verifyAccessToken } from '../auth/jwt.ts';
import { RateLimiter } from './rate-limit.ts';
import { registerPagentTools, type PageOps } from './tools.ts';

export type McpHttpConfig = {
  publicUrl: string;
  pageTtlMs: number;
  /** Override for the request body cap. Defaults to MAX_BODY_BYTES from
   *  app.ts so REST and MCP enforce the same limit unless tests need otherwise. */
  maxBodyBytes?: number;
  /** Override the rate limiter (e.g. for tests). Defaults to a per-IP limiter
   *  using RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS — same envs as the REST side. */
  rateLimiter?: RateLimiter;
};

// Mirrors apps/api/request-id.ts — caller-supplied IDs accepted within bounds,
// otherwise generated.
const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
// Headers a browser-side MCP client might preflight. `Mcp-Session-Id` is
// reserved by the SDK transport even in stateless mode — clients may still
// echo it on resumed sessions.
const CORS_ALLOWED_HEADERS = 'Content-Type, Mcp-Session-Id, X-Request-Id';
// Methods the SDK's streamable HTTP transport actually serves.
const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';

function getOrCreateRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && REQUEST_ID_REGEX.test(incoming)) return incoming;
  return randomBytes(16).toString('hex');
}

/**
 * Headers applied to every /mcp response: request-id echo, nosniff, and
 * a CORS Allow-Origin that mirrors the REST CORS policy (allow-list in
 * production, `*` when ALLOWED_ORIGINS is unset for local dev).
 */
function applyBaseHeaders(req: IncomingMessage, res: ServerResponse, requestId: string): void {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    // Always set Vary: Origin when the response varies by Origin — caches
    // in front of the API need this even when the value is `*`.
    res.setHeader('Vary', 'Origin');
    if (!ALLOWED_ORIGINS) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
}

export function buildInProcessOps(cfg: McpHttpConfig): PageOps {
  return {
    async showUi(spec, ownerId) {
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
    async showHtml(html, ownerId) {
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
    async checkResult(page_id) {
      return store.advanceResult(page_id);
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
      res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
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
      const result = limiter.check(clientKey(req.headers['x-forwarded-for']));
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
    if (env.REQUIRE_AUTH && req.method === 'POST') {
      const authHeader = req.headers.authorization;
      const resourceMetadataUrl = `${cfg.publicUrl}/.well-known/oauth-protected-resource`;
      if (!authHeader?.startsWith('Bearer ')) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
        respondJson(res, 401, {
          error: 'unauthorized',
          message: 'Bearer token required',
          request_id: requestId,
        });
        return;
      }
      const token = authHeader.slice('Bearer '.length).trim();
      try {
        const claims = await verifyAccessToken(token);
        // Attach auth info onto the request so the SDK transport can forward
        // it to tool handlers (the StreamableHTTPServerTransport reads
        // `req.auth` per the SDK's contract). We carry the verified claims
        // plus the raw bearer so downstream code can re-mint scoped requests
        // without re-decoding the JWT.
        (req as unknown as { auth: unknown }).auth = {
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

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Reject early if the caller sent a body without claiming JSON. The SDK
  // would still try to parse it, but failing fast with a clear message
  // beats an opaque downstream error.
  const ct = req.headers['content-type']?.toLowerCase() ?? '';
  if (!ct.startsWith('application/json')) {
    throw new Error(`Content-Type must be application/json (got ${ct ? `"${ct}"` : 'none'})`);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      // Don't destroy the socket — that would tear down the response we're
      // about to send. Just stop accumulating; Node will drain the stream.
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new Error(`request body exceeds the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}
