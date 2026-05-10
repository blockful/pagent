import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildCsp } from './csp.js';

// Vercel and other CI runners surface unset env vars as empty strings, which
// would otherwise fail .url() / .coerce.number(). Normalise "" → undefined.
const envSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === '' ? undefined : v;
    }
    return out;
  },
  z.object({
    API_PORT: z.coerce.number().int().min(1).max(65535).optional().default(8787),
    CLIENT_PORT: z.coerce.number().int().min(1).max(65535).optional().default(8788),
    VITE_API_URL: z
      .string()
      .url('VITE_API_URL must be a valid URL (e.g. https://pagent.up.railway.app)')
      .optional(),
  }),
);

// 128-bit hex page id (must match server.ts).
const PAGE_ID = String.raw`[a-f0-9]{32}`;

export default defineConfig(({ command }) => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment for web app:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const env = parsed.data;

  // VITE_API_URL is inlined at build time and embedded in CSP/meta. Missing
  // it produces a bundle that calls relative paths — silent failure in prod
  // where the renderer and API live on different origins. Fail loud here.
  if (command === 'build' && !env.VITE_API_URL) {
    console.error(
      'VITE_API_URL is required for `vite build`. Set it to the API origin (e.g. https://pagent.up.railway.app).',
    );
    process.exit(1);
  }

  const API_TARGET = `http://localhost:${env.API_PORT}`;

  return {
    plugins: [
      {
        name: 'pagent-csp',
        transformIndexHtml: {
          order: 'pre',
          handler(html) {
            const csp = buildCsp(env.VITE_API_URL);
            return html.replace(
              /<head>/i,
              `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
            );
          },
        },
      },
    ],
    // The web app is its own Vite root now (apps/web/). index.html lives here.
    server: {
      port: env.CLIENT_PORT,
      strictPort: true,
      proxy: {
        '/new': { target: API_TARGET, changeOrigin: true },
        '/health': { target: API_TARGET, changeOrigin: true },
        '/openapi.json': { target: API_TARGET, changeOrigin: true },
        '/openapi.yaml': { target: API_TARGET, changeOrigin: true },
        '/docs': { target: API_TARGET, changeOrigin: true },
        // /:id/result — always API.
        [`^/${PAGE_ID}/result(?:\\?.*)?$`]: { target: API_TARGET, changeOrigin: true },
        // /:id — content-negotiated. Browser navigation (Accept: text/html) gets
        // the SPA; fetch() from the renderer (Accept: */*) is proxied to the API.
        [`^/${PAGE_ID}(?:\\?.*)?$`]: {
          target: API_TARGET,
          changeOrigin: true,
          bypass(req) {
            const accept = req.headers.accept ?? '';
            if (accept.includes('text/html')) return '/index.html';
          },
        },
      },
    },
    build: {
      outDir: resolve(import.meta.dirname, 'dist'),
      emptyOutDir: true,
    },
    appType: 'spa',
  };
});
