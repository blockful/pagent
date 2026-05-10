import './tracing.ts';
import { serve } from '@hono/node-server';
import * as db from './db.ts';
import { env } from './schemas.ts';
import { app, PORT, PUBLIC_URL } from './app.ts';
import { logger } from './logger.ts';

// --- Boot --------------------------------------------------------------------

await db.init(env.DATABASE_URL);

// Periodically reclaim expired DB rows. Correctness is enforced by
// WHERE expires_at > now() on every read — this sweep is only for space.
setInterval(async () => {
  try {
    const deleted = await db.deleteExpiredPages();
    if (deleted > 0) logger.debug({ deleted }, 'ttl sweep removed expired pages');
  } catch (err) {
    logger.error({ err }, 'ttl sweep failed');
  }
}, 60_000).unref();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(`pagent listening on ${PUBLIC_URL} (port ${info.port})`);
});

const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await db.shutdown();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
