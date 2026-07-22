import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { App } from "./app/App";
import { initApiBase } from "./shared/api/client";
import { UiProvider } from "./shared/ui/UiProvider";
import "./shared/styles/global.css";

const isElectron = Boolean(
  (window as unknown as { kongkuDesktop?: unknown }).kongkuDesktop,
);
const Router = isElectron ? HashRouter : BrowserRouter;

void (async () => {
  await initApiBase();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <UiProvider>
        <Router>
          <App />
        </Router>
      </UiProvider>
    </StrictMode>,
  );
})();
