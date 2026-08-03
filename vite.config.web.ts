import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * Build config for the standalone web player bundle served by the axum LAN
 * streaming server. Decoupled from `vite.config.ts` (the Tauri desktop
 * shell) so the two bundles can have independent `publicDir`s -- the web
 * player needs its own manifest.webmanifest, service worker, and icons at
 * the served root.
 */
export default defineConfig({
  root: path.resolve(__dirname, 'web-player'),
  publicDir: path.resolve(__dirname, 'web-player/public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web-player'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      // Single entry: the SPA (index.html). The service worker is NOT a
      // rollup entry -- it ships verbatim from web-player/public/ via Vite's
      // publicDir, so it lands at /sw.js (root scope) unhashed as SWs require.
      input: {
        main: path.resolve(__dirname, 'web-player/index.html'),
      },
    },
  },
});
