import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { buildCsp } from './csp.js';

const API_PORT = process.env.API_PORT ?? '8787';
const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? 8788);
const API_TARGET = `http://localhost:${API_PORT}`;

// 128-bit hex page id (must match server.ts).
const PAGE_ID = String.raw`[a-f0-9]{32}`;

export default defineConfig({
  plugins: [
    {
      name: 'pagent-csp',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const csp = buildCsp(process.env.VITE_API_URL);
          return html.replace(
            /<head>/,
            `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
          );
        },
      },
    },
  ],
  // The web app is its own Vite root now (apps/web/). index.html lives here.
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    proxy: {
      '/v1/new': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      // /v1/:id/result — always API.
      [`^/v1/${PAGE_ID}/result(?:\\?.*)?$`]: { target: API_TARGET, changeOrigin: true },
      // /v1/:id — content-negotiated. Browser navigation (Accept: text/html) gets
      // the SPA; fetch() from the renderer (Accept: */*) is proxied to the API.
      [`^/v1/${PAGE_ID}(?:\\?.*)?$`]: {
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
});
