import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { FileViewerWindow } from "./FileViewerWindow.tsx";
import "./index.css";
import "./styles/globals.css";
import { initializeTheme } from "./lib/utils";
import { I18nProvider } from "./lib/i18n";

// Initialize theme before rendering
initializeTheme();

const mode = new URLSearchParams(window.location.search).get("mode");
const root = (
  <I18nProvider>
    {mode === "file-viewer" ? <FileViewerWindow /> : <App />}
  </I18nProvider>
);

createRoot(document.getElementById("root")!).render(root);
