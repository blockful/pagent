import { serve } from '@hono/node-server';
import * as db from './db.ts';
import { env } from './schemas.ts';
import { app, pages, PORT, PUBLIC_URL } from './app.ts';

// --- Boot --------------------------------------------------------------------

await db.init(env.DATABASE_URL);
await db.loadActivePages(pages);
console.log(`rehydrated ${pages.size} page(s) from db`);

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`pagent listening on ${PUBLIC_URL} (port ${info.port})`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close();
  await db.shutdown();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
