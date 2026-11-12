import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { createPreloadErrorHandler } from "./lib/preloadReload";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/themes.generated.css";
import "./styles/global.css";
import "./styles/workspace.css";
import "./components/comments/comments.css";
import "./components/comments/tray.css";
import "./components/artifacts/artifacts.css";
import "./styles/chat.css";
import "./components/chat/outline/outline.css";
import "./components/chat/find/find.css";
import "./components/preview/scrollmap/scrollmap.css";
import "./styles/tasks.css";
import "./styles/mentions.css";
import "./styles/selection.css";

window.addEventListener(
  "vite:preloadError",
  createPreloadErrorHandler(() => window.location.reload()),
);

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

