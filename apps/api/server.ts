import './tracing.ts';
import { createServer, type Server as HttpServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import * as db from './db.ts';
import { env } from './schemas.ts';
import { app, PORT, PUBLIC_URL, PAGE_TTL_MS } from './app.ts';
import { initKeys } from './auth/jwt.ts';
import { makeMcpHttpHandler } from './mcp/http.ts';
import { logger } from './logger.ts';
import { metrics } from './metrics.ts';
import { shutdownTracing } from './tracing.ts';

// --- Boot --------------------------------------------------------------------

await db.init(env.DATABASE_URL);

// Initialize the Ed25519 JWT signing keys once at startup, so /oauth/token
// (signAccessToken) and /.well-known/jwks.json (getJwks) don't throw on
// first request. The env schema's superRefine guarantees both vars are
// present when REQUIRE_AUTH=true; the explicit error branch below is
// defense-in-depth against a future schema refactor that drops the check.
if (env.JWT_SIGNING_KEY && env.JWT_PUBLIC_KEY) {
  await initKeys(env.JWT_SIGNING_KEY, env.JWT_PUBLIC_KEY);
  logger.info('JWT signing keys initialized');
} else if (env.REQUIRE_AUTH) {
  logger.error('REQUIRE_AUTH=true but JWT keys missing — refusing to start');
  process.exit(1);
}

// Periodically reclaim expired DB rows. Correctness is enforced by
// WHERE expires_at > now() on every read — this sweep is only for space.
// Counts pages whose TTL fired while still 'open' as abandoned.
const sweepTimer = setInterval(async () => {
  try {
    const { total, abandoned } = await db.deleteExpiredPages();
    if (abandoned > 0) metrics.pagesAbandoned.add(abandoned);
    if (total > 0) logger.debug({ total, abandoned }, 'ttl sweep removed expired pages');
  } catch (err) {
    logger.error({ err }, 'ttl sweep failed');
  }
}, 60_000);
sweepTimer.unref();

// Multiplex: /mcp goes through the MCP HTTP transport (which writes directly
// to the underlying response stream — Hono can't host that cleanly); every
// other path falls through to the Hono app.
const honoListener = getRequestListener(app.fetch);
const mcpHandler = makeMcpHttpHandler({ publicUrl: PUBLIC_URL, pageTtlMs: PAGE_TTL_MS });

const server: HttpServer = createServer((req, res) => {
  const path = req.url?.split('?', 1)[0];
  if (path === '/mcp' || path?.startsWith('/mcp/')) {
    void mcpHandler(req, res);
    return;
  }
  honoListener(req, res);
});

server.listen(PORT, () => {
  logger.info(`pagent listening on ${PUBLIC_URL} (port ${PORT})`);
});

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return; // double-signal guard
  shuttingDown = true;
  logger.info({ signal }, 'received signal, shutting down');

  // Stop the TTL sweep first so its next tick can't race the db.shutdown.
  clearInterval(sweepTimer);

  // Stop accepting new connections; resolves when all in-flight ones finish.
  const drained = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  // Hard cap: after N seconds, force-close idle connections so we don't
  // hang on lingering keep-alives.
  const forceClose = setTimeout(() => {
    logger.warn({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'shutdown timeout reached, forcing close');
    server.closeAllConnections();
  }, SHUTDOWN_TIMEOUT_MS);
  forceClose.unref();

  try {
    await drained;
  } catch (err) {
    logger.error({ err }, 'error draining server connections');
  } finally {
    clearTimeout(forceClose);
  }

  try {
    await shutdownTracing();
  } catch (err) {
    logger.error({ err }, 'error during OpenTelemetry shutdown');
  }

  await db.shutdown();
  logger.info('shutdown complete');
  // Flush pino's worker-thread transports (incl. pino-opentelemetry-transport)
  // before exiting, or buffered log records get dropped on SIGTERM.
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
