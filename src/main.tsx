import i18n, { applyLanguageFromPreference } from "./lib/i18n";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { FileViewerWindow } from "./FileViewerWindow.tsx";
import "./index.css";
import "./styles/globals.css";
import { initializeTheme } from "./lib/utils";
import { ConfigSyncRuntime } from './components/config-sync-review';
import { recoverConfigSync } from './lib/config-sync/controller';

const mode = new URLSearchParams(window.location.search).get("mode");
async function bootstrap() {
  const target = document.getElementById('root')!;
  try {
    if (mode !== 'file-viewer') await recoverConfigSync();
    initializeTheme();
    void applyLanguageFromPreference();
    createRoot(target).render(mode === 'file-viewer' ? <FileViewerWindow /> : <><App /><ConfigSyncRuntime /></>);
  } catch {
    // Never let loaders observe a partially restored configuration.
    const message = document.createElement('p'); message.textContent = i18n.t('cloudSync.errors.SYNC_RECOVERY_REQUIRED');
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = i18n.t('cloudSync.retry');
    retry.onclick = () => { void bootstrap(); };
    target.replaceChildren(message, retry);
  }
}
void bootstrap();
