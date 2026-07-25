/**
 * electron-updater（GitHub Releases）。
 */

const { app, ipcMain, shell } = require("electron");
const state = require("./state.cjs");

function softenUpdaterError(msg) {
  const text = String(msg || "");
  if (
    /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(
      text,
    )
  ) {
    return "下载更新时网络中断（GitHub 大文件在国内易断开）。请重试，或改用浏览器手动下载安装包。";
  }
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerOpenReleasesOnly() {
  ipcMain.handle("updater:open-releases", async () => {
    await shell.openExternal(
      "https://github.com/codehyd/Knowledge-Base/releases/latest",
    );
    return true;
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    ipcMain.handle("updater:check", async () => ({
      ok: false,
      reason: "dev",
      message: "开发模式不检查更新，请使用安装包验证",
    }));
    registerOpenReleasesOnly();
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    ipcMain.handle("updater:check", async () => ({
      ok: false,
      reason: "missing",
      message: `未加载更新模块：${String(err)}`,
    }));
    registerOpenReleasesOnly();
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("update-available", (info) => {
    state.mainWindow?.webContents.send("updater:available", {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    state.mainWindow?.webContents.send("updater:not-available", {
      version: info.version,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    state.mainWindow?.webContents.send("updater:progress", {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    state.mainWindow?.webContents.send("updater:downloaded", {
      version: info.version,
    });
  });
  autoUpdater.on("error", (err) => {
    state.mainWindow?.webContents.send(
      "updater:error",
      softenUpdaterError(err?.message || err),
    );
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 5000);

  ipcMain.handle("updater:check", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const remote = result?.updateInfo?.version;
      const current = app.getVersion();
      return {
        ok: true,
        currentVersion: current,
        remoteVersion: remote,
      };
    } catch (err) {
      const message = softenUpdaterError(err?.message || err);
      state.mainWindow?.webContents.send("updater:error", message);
      return { ok: false, reason: "error", message };
    }
  });

  ipcMain.handle("updater:download", async () => {
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await autoUpdater.downloadUpdate();
        return { ok: true, attempts: attempt };
      } catch (err) {
        lastErr = err;
        const message = String(err?.message || err);
        const retryable =
          /ERR_CONNECTION|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(
            message,
          );
        console.warn(
          `[kongku] downloadUpdate attempt ${attempt}/${maxAttempts} failed:`,
          message,
        );
        if (!retryable || attempt === maxAttempts) break;
        await sleep(1500 * attempt);
      }
    }
    const message = softenUpdaterError(lastErr?.message || lastErr);
    state.mainWindow?.webContents.send("updater:error", message);
    throw new Error(message);
  });

  ipcMain.handle("updater:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("updater:open-releases", async (_event, version) => {
    const ver =
      typeof version === "string" ? version.trim().replace(/^v/, "") : "";
    const url = ver
      ? `https://github.com/codehyd/Knowledge-Base/releases/tag/v${ver}`
      : "https://github.com/codehyd/Knowledge-Base/releases/latest";
    await shell.openExternal(url);
    return true;
  });
}

module.exports = { setupAutoUpdater };
