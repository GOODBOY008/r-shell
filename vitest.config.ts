import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // connection.test.ts is an integration test requiring a live SSH server
    // (localhost:22, testuser/testpass) and the Tauri runtime — not runnable
    // in the jsdom unit-test environment or CI.
    exclude: ['src/__tests__/connection.test.ts', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['./src/__tests__/i18n-setup.ts'],
  },
});
