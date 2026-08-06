/**
 * 渲染进程 IPC：配置、媒体、打开本机路径。
 */

const { app, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const state = require("./state.cjs");
const {
  exportMediaCookiesFile,
  openMediaLoginWindow,
  openVideoPreviewWindow,
  douyinLoginCookieStats,
  bilibiliLoginCookieStats,
} = require("./media.cjs");
const { API_ORIGIN, runtimeDataDir, ytDlpCookiesPath } = require("./paths.cjs");
const { normalizeExternalUrl } = require("./external-url.cjs");

function registerIpcHandlers() {
  ipcMain.handle("kongku:getConfig", async () => {
    // 勿在 getConfig 里等 /health：渲染进程 initApiBase 会卡住 boot-splash
    const cookiesPath = ytDlpCookiesPath();
    let cookiesReady = false;
    try {
      cookiesReady =
        fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 80;
    } catch {
      cookiesReady = false;
    }
    let douyinCookiesReady = false;
    let bilibiliCookiesReady = false;
    try {
      const [douyin, bilibili] = await Promise.all([
        douyinLoginCookieStats(),
        bilibiliLoginCookieStats(),
      ]);
      douyinCookiesReady = Boolean(douyin.loggedIn);
      bilibiliCookiesReady = Boolean(bilibili.loggedIn);
      // 兼容旧字段：任一平台已登录或 cookies 文件可用
      cookiesReady = cookiesReady || douyinCookiesReady || bilibiliCookiesReady;
    } catch {
      /* session 未就绪时退回文件探测 */
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
      douyinCookiesReady,
      bilibiliCookiesReady,
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

  ipcMain.handle("shell:open-external", async (_event, rawUrl) => {
    const next = normalizeExternalUrl(typeof rawUrl === "string" ? rawUrl : "");
    if (!next) {
      return { ok: false, message: "无效链接" };
    }
    try {
      await shell.openExternal(next);
      return { ok: true, url: next };
    } catch (e) {
      return { ok: false, message: String(e?.message || e) };
    }
  });
}

module.exports = { registerIpcHandlers };
