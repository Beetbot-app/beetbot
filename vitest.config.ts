import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Frontend tests.
 *
 * Deliberately separate from `vite.config.ts` rather than folded into it: the
 * app config carries Tailwind and a fixed Tauri dev-server port, neither of
 * which a test run should have an opinion about.
 *
 * jsdom, not a real browser. Everything tested here is decision-shaped — does
 * this render, does that call happen, is the destructive thing gated — and none
 * of it depends on layout or a real audio pipeline.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: [
      'shared/**/*.test.{ts,tsx}',
      'web-player/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
    // src-tauri is Rust and has its own `cargo test`.
    exclude: ['**/node_modules/**', '**/dist/**', 'src-tauri/**'],
  },
});
