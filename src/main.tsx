import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initializeTheme } from "./lib/utils";

// Initialize theme before rendering
initializeTheme();

createRoot(document.getElementById("root")!).render(<App />);
