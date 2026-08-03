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

  // API 与窗口并行：开发态先出 Vite UI，不再卡在「等后端」启动页上
  const apiPromise = startApiSynced().catch((err) => {
    state.apiStatus = "failed";
    state.apiLastError = String(err);
    console.warn("[kongku] API start:", err);
  });

  try {
    // deferDevLoad=false：Vite 就绪即加载前端；AppLayout 会自行探测 API
    await createWindow({ deferDevLoad: false });
  } catch (err) {
    console.error("[kongku] createWindow:", err);
  }

  // 打包态仍需等 API 托管静态页；开发态 UI 已加载，这里只等 API 落状态
  if (app.isPackaged) {
    await apiPromise;
    try {
      await loadAppUi();
    } catch (err) {
      console.error("[kongku] loadAppUi:", err);
    }
  } else {
    void apiPromise.then(() => {
      console.log("[kongku] API 后台就绪:", state.apiStatus);
    });
  }
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void (async () => {
        await createWindow({ deferDevLoad: false });
        if (app.isPackaged) {
          await loadAppUi();
        }
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
