/**
 * 空库 Electron 主进程入口
 *
 * 职责：组装模块、生命周期；具体实现见 electron/lib/*
 * 1. 打开桌面窗口，加载前端（打包后）或开发态 Vite
 * 2. 与窗口同步：启动时拉起本机 API，退出时结束自己拉起的 API
 * 3. electron-updater（GitHub Releases）
 */

const { app, BrowserWindow } = require("electron");

const state = require("./lib/state.cjs");
const { startApiSynced, stopApi } = require("./lib/api-process.cjs");
const {
  createWindow,
  loadAppUi,
  loadDevUiAfterApi,
} = require("./lib/window.cjs");
const { setupAutoUpdater } = require("./lib/updater.cjs");
const { registerIpcHandlers } = require("./lib/ipc.cjs");
const {
  startDouyinBridge,
  stopDouyinBridge,
} = require("./lib/douyin-bridge.cjs");
const { clearUiCacheIfVersionChanged } = require("./lib/ui-cache.cjs");

// 关闭 Fluent/Overlay 滚动条，避免忽略页面 ::-webkit-scrollbar 自定义样式
app.commandLine.appendSwitch(
  "disable-features",
  "OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbars",
);

app.whenReady().then(async () => {
  await clearUiCacheIfVersionChanged();
  registerIpcHandlers();
  startDouyinBridge();

  // 开发态：先开窗口显示「启动中」，等 API 就绪后再加载 Vite
  const apiPromise = startApiSynced().catch((err) => {
    state.apiStatus = "failed";
    state.apiLastError = String(err);
    console.warn("[kongku] API start:", err);
  });

  try {
    await createWindow({ deferDevLoad: !app.isPackaged });
  } catch (err) {
    console.error("[kongku] createWindow:", err);
  }

  await apiPromise;
  await loadDevUiAfterApi();

  try {
    await loadAppUi();
  } catch (err) {
    console.error("[kongku] loadAppUi:", err);
  }
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void (async () => {
        await createWindow();
        await loadAppUi();
      })();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopApi();
    stopDouyinBridge();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopApi();
  stopDouyinBridge();
});
