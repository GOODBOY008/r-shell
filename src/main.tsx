import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { FileViewerWindow } from "./FileViewerWindow.tsx";
import "./index.css";
import "./styles/globals.css";
import { initializeTheme } from "./lib/utils";

// Initialize theme before rendering
initializeTheme();

const mode = new URLSearchParams(window.location.search).get("mode");
const root = mode === "file-viewer" ? <FileViewerWindow /> : <App />;

createRoot(document.getElementById("root")!).render(root);
