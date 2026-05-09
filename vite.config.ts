import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const API_PORT = process.env.API_PORT ?? '8787';
const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? 8788);

export default defineConfig({
  root: 'client',
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    proxy: {
      '/sessions': { target: `http://localhost:${API_PORT}`, changeOrigin: true, ws: false },
      '/healthz': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
  },
  appType: 'spa',
});
