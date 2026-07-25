/**
 * 渲染进程 IPC：配置、媒体、打开本机路径。
 */

const { app, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const state = require("./state.cjs");
const { waitForHealth } = require("./api-process.cjs");
const {
  exportMediaCookiesFile,
  openMediaLoginWindow,
  openVideoPreviewWindow,
} = require("./media.cjs");
const { API_ORIGIN, runtimeDataDir, ytDlpCookiesPath } = require("./paths.cjs");

function registerIpcHandlers() {
  ipcMain.handle("kongku:getConfig", async () => {
    try {
      await waitForHealth(1200);
      state.apiStatus = "ready";
      state.apiLastError = "";
    } catch {
      /* 保持 failed / starting 状态 */
    }
    const cookiesPath = ytDlpCookiesPath();
    let cookiesReady = false;
    try {
      cookiesReady =
        fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 80;
    } catch {
      cookiesReady = false;
    }
    return {
      apiOrigin: API_ORIGIN,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      apiStatus: state.apiStatus,
      apiLastError: state.apiLastError,
      apiSpawnedByUs: state.apiSpawnedByUs,
      dataDir: runtimeDataDir(),
      mediaCookiesReady: cookiesReady,
      mediaCookiesPath: cookiesPath,
    };
  });

  ipcMain.handle("media:login", async (_event, site) => {
    return openMediaLoginWindow(typeof site === "string" ? site : "douyin");
  });

  ipcMain.handle("media:export-cookies", async () => {
    return exportMediaCookiesFile();
  });

  ipcMain.handle("media:open-preview", async (_event, url, title) => {
    return openVideoPreviewWindow(url, typeof title === "string" ? title : "");
  });

  ipcMain.handle("shell:open-path", async (_event, targetPath) => {
    const raw = typeof targetPath === "string" ? targetPath.trim() : "";
    if (!raw) {
      return { ok: false, message: "路径为空" };
    }
    const resolved = path.resolve(raw);
    const dataRoot = path.resolve(runtimeDataDir());
    const rel = path.relative(dataRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, message: "只能打开应用数据目录内的路径" };
    }
    try {
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      const err = await shell.openPath(resolved);
      if (err) return { ok: false, message: err };
      return { ok: true };
    } catch (e) {
      return { ok: false, message: String(e?.message || e) };
    }
  });
}

module.exports = { registerIpcHandlers };
