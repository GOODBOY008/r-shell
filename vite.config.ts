import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from 'url';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Only apply Tauri API mocks when running standalone frontend dev (pnpm dev),
// not when running through Tauri CLI (pnpm tauri dev / pnpm tauri build)
const isTauriRun = !!(process as any).env.TAURI_DEBUG || !!(process as any).env.TAURI_TARGET;

const tauriMockAlias: Record<string, string> = {}
if (!isTauriRun) {
  const mockDir = path.resolve(__dirname, './src/lib/__mocks__');
  tauriMockAlias['@tauri-apps/api/core'] = path.join(mockDir, 'tauri-core.ts');
  tauriMockAlias['@tauri-apps/api/event'] = path.join(mockDir, 'tauri-event.ts');
  tauriMockAlias['@tauri-apps/api/window'] = path.join(mockDir, 'tauri-window.ts');
  tauriMockAlias['@tauri-apps/plugin-clipboard-manager'] = path.join(mockDir, 'tauri-clipboard.ts');
  tauriMockAlias['@tauri-apps/plugin-dialog'] = path.join(mockDir, 'tauri-dialog.ts');
  tauriMockAlias['@tauri-apps/plugin-fs'] = path.join(mockDir, 'tauri-fs.ts');
  tauriMockAlias['@tauri-apps/plugin-process'] = path.join(mockDir, 'tauri-process.ts');
  tauriMockAlias['@tauri-apps/plugin-updater'] = path.join(mockDir, 'tauri-updater.ts');
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      ...tauriMockAlias,
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
