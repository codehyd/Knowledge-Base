import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { App } from "./app/App";
import { initApiBase } from "./shared/api/client";
import { UiProvider } from "./shared/ui/UiProvider";
import { RootErrorBoundary, installFatalErrorOverlay } from "./shared/ui/RootErrorBoundary";
import "./shared/styles/global.css";

installFatalErrorOverlay();

const isElectron = Boolean(
  (window as unknown as { kongkuDesktop?: unknown }).kongkuDesktop,
);
const Router = isElectron ? HashRouter : BrowserRouter;

function dismissBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash || splash.dataset.dismissed === "1") return;
  splash.dataset.dismissed = "1";

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
  // 最多等 1.5s 拿 apiBase，避免 IPC/探测拖住启动页
  await Promise.race([
    initApiBase(),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
  ]);
  try {
        createRoot(document.getElementById("root")!).render(
          <StrictMode>
            <RootErrorBoundary>
              <UiProvider>
                <Router>
                  <App />
                </Router>
              </UiProvider>
            </RootErrorBoundary>
          </StrictMode>,
        );
  } finally {
    dismissBootSplash();
  }
})();
