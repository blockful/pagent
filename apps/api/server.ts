import './tracing.ts';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import * as db from './db.ts';
import { env } from './schemas.ts';
import { app, PORT, PUBLIC_URL } from './app.ts';
import { logger } from './logger.ts';
import { metrics } from './metrics.ts';
import { shutdownTracing } from './tracing.ts';

// --- Boot --------------------------------------------------------------------

await db.init(env.DATABASE_URL);

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

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(`pagent listening on ${PUBLIC_URL} (port ${info.port})`);
}) as HttpServer;

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
