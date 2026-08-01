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

function dismissBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash) return;

  const remove = () => {
    splash.remove();
  };

  // 双 rAF：等首帧 React 画出来再淡出，避免闪白
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      splash.classList.add("is-leave");
      const done = () => {
        splash.removeEventListener("transitionend", done);
        remove();
      };
      splash.addEventListener("transitionend", done);
      window.setTimeout(remove, 500);
    });
  });
}

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
  dismissBootSplash();
})();
