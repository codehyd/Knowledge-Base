/**
 * 主窗口：创建、启动页、加载 UI。
 */

const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const state = require("./state.cjs");
const { waitForHttp } = require("./http-wait.cjs");
const {
  API_ORIGIN,
  DEV_WEB,
  DESKTOP_DIR,
  ELECTRON_DIR,
  repoRoot,
  webDistIndex,
  windowIconPath,
  preloadPath,
} = require("./paths.cjs");

function splashHtmlPath() {
  return path.join(ELECTRON_DIR, "splash", "index.html");
}

function splashLogoPath() {
  const candidates = [
    path.join(repoRoot(), "apps", "web", "public", "logo-wordmark.png"),
    path.join(process.resourcesPath || "", "web", "logo-wordmark.png"),
    path.join(DESKTOP_DIR, "build", "icon.png"),
    path.join(ELECTRON_DIR, "icon.png"),
  ];
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function splashLogoDataUrl() {
  const file = splashLogoPath();
  if (!file) return null;
  try {
    const buf = fs.readFileSync(file);
    const mime = file.toLowerCase().endsWith(".ico") ? "image/x-icon" : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function escapeHtml(text) {
  return String(text || "").replace(/[<>&]/g, "");
}

function isSplashUrl(url) {
  const u = String(url || "");
  return u.includes("/splash/index.html") || u.includes("splash%2Findex.html");
}

async function setSplashStatus(message) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return false;
  try {
    if (!isSplashUrl(state.mainWindow.webContents.getURL())) return false;
    const safe = JSON.stringify(String(message || ""));
    await state.mainWindow.webContents.executeJavaScript(
      `window.__kongkuSetSplashStatus && window.__kongkuSetSplashStatus(${safe})`,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

async function injectSplashLogo() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  const dataUrl = splashLogoDataUrl();
  if (!dataUrl) return;
  try {
    await state.mainWindow.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById("logo");
        const fallback = document.getElementById("brandFallback");
        if (!el) return;
        el.onerror = null;
        el.src = ${JSON.stringify(dataUrl)};
        el.style.display = "block";
        if (fallback) fallback.style.display = "none";
      })()`,
      true,
    );
  } catch (err) {
    console.warn("[kongku] splash logo inject:", err);
  }
}

async function showStartupSplash(message) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;

  const msg = String(message || "正在拉起本机服务");
  if (await setSplashStatus(msg)) return;

  const splashFile = splashHtmlPath();
  if (!fs.existsSync(splashFile)) {
    const html = `<!doctype html><meta charset="utf-8"/><title>空库</title>
<body style="font-family:sans-serif;padding:48px;color:#1f2933;background:#f4f6f7;line-height:1.6">
<h1 style="margin:0 0 12px">空库启动中…</h1>
<p style="margin:0;color:#6b7280">${escapeHtml(msg)}</p>
</body>`;
    await state.mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return;
  }

  await state.mainWindow.loadFile(splashFile, { query: { msg } });
  await injectSplashLogo();
}

async function createWindow(options = {}) {
  const deferDevLoad = Boolean(options.deferDevLoad);
  Menu.setApplicationMenu(null);

  const icon = windowIconPath();
  state.mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f6f7",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const reveal = () => {
    if (
      state.mainWindow &&
      !state.mainWindow.isDestroyed() &&
      !state.mainWindow.isVisible()
    ) {
      state.mainWindow.show();
    }
  };
  state.mainWindow.once("ready-to-show", reveal);
  setTimeout(reveal, 2500);

  state.mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.warn("[kongku] did-fail-load", code, desc, url);
    reveal();
  });

  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged) {
    const devUrl =
      process.env.KONGKU_DEV_WEB === undefined
        ? DEV_WEB
        : process.env.KONGKU_DEV_WEB;
    if (devUrl) {
      try {
        console.log(`[kongku] 等待 Vite：${devUrl}`);
        await waitForHttp(devUrl, 90000, "Vite");
        if (deferDevLoad) {
          await showStartupSplash("正在启动后端 API，请稍候…");
        } else {
          await state.mainWindow.loadURL(devUrl);
        }
      } catch (err) {
        console.error("[kongku] Vite 未就绪:", err);
        const tip = `<!doctype html><meta charset="utf-8"/><title>空库</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:"IBM Plex Sans","PingFang SC",sans-serif;color:#1f2933;background:#f4f6f7;line-height:1.6}
  .box{max-width:520px;padding:40px 32px}
  h1{margin:0 0 12px;font-size:22px;color:#2a6f6a}
  p{margin:0 0 12px;color:#6b7280}
  pre{background:#fff;padding:12px;border:1px solid #d7dde2;border-radius:10px;overflow:auto}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<body><div class="box">
<h1>前端 Vite 未启动</h1>
<p>Electron 开发态需要先开网页 Vite（端口 41779），再开桌面壳。</p>
<p>请另开终端执行：</p>
<pre>cd apps/web
npm run dev</pre>
<p>或一键：<code>scripts/dev-electron.ps1</code> / <code>scripts/dev-electron.sh</code></p>
<p>${escapeHtml(err)}</p>
</div></body>`;
        await state.mainWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(tip)}`,
        );
      }
      return;
    }
  }

  await showStartupSplash("正在拉起本机服务，首次启动可能需要几十秒。");
}

async function loadAppUi() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  if (!app.isPackaged) return;

  try {
    await waitForHttp(`${API_ORIGIN}/`, 15000, "Web", { okStatuses: [200] });
    await state.mainWindow.loadURL(`${API_ORIGIN}/`);
    console.log("[kongku] UI loaded from API origin");
    return;
  } catch (err) {
    console.warn("[kongku] API 未托管前端，回退 loadFile:", err);
  }

  const indexHtml = webDistIndex();
  if (fs.existsSync(indexHtml)) {
    await state.mainWindow.loadFile(indexHtml);
  } else {
    await state.mainWindow.loadURL(API_ORIGIN);
  }
}

async function loadDevUiAfterApi() {
  if (app.isPackaged) return;
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;

  const devUrl =
    process.env.KONGKU_DEV_WEB === undefined
      ? DEV_WEB
      : process.env.KONGKU_DEV_WEB;
  if (!devUrl) return;

  if (state.apiStatus === "ready") {
    try {
      await state.mainWindow.loadURL(devUrl);
    } catch (err) {
      console.error("[kongku] 加载 Vite 失败:", err);
    }
    return;
  }

  await showStartupSplash(
    state.apiLastError
      ? `后端启动失败：${state.apiLastError}。请查看 data/api-dev.log`
      : "后端未就绪，请稍后重试或重启 npm run dev",
  );
}

module.exports = {
  showStartupSplash,
  createWindow,
  loadAppUi,
  loadDevUiAfterApi,
};
