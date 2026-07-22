/**
 * 空库 Electron 主进程
 *
 * 职责：
 * 1. 打开桌面窗口，加载前端静态资源（打包后）或开发态 Vite
 * 2. 与窗口同步：启动时拉起本机 API，退出时结束自己拉起的 API
 * 3. electron-updater（GitHub Releases）
 *
 * 数据库：不启停 Postgres；无库时由 API /health 与前端提示。
 */

const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {import('child_process').ChildProcess | null} */
let apiChild = null;
/** 是否由本进程拉起的 API（外部已占用端口时为 false，退出不杀） */
let apiSpawnedByUs = false;
/** @type {"unknown" | "starting" | "ready" | "failed"} */
let apiStatus = "unknown";
let apiLastError = "";

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.KONGKU_API_PORT || 18765);
const API_ORIGIN = `http://${API_HOST}:${API_PORT}`;
const DEV_WEB = process.env.KONGKU_DEV_WEB || "http://127.0.0.1:41779";

function webDistIndex() {
  return path.join(process.resourcesPath, "web", "index.html");
}

function apiSidecarPath() {
  const bin =
    process.platform === "win32" ? "kongku-api.exe" : "kongku-api";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "api", bin);
  }
  return path.join(__dirname, "..", "resources", "api", bin);
}

function repoRoot() {
  // apps/desktop/electron -> 仓库根
  return path.resolve(__dirname, "..", "..", "..");
}

function loadDotEnvInto(env) {
  const candidates = [
    path.join(repoRoot(), ".env"),
    path.join(process.cwd(), ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (env[key] === undefined) env[key] = val;
      }
    } catch {
      /* ignore */
    }
    break;
  }
  return env;
}

function waitForHealth(timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      // /health 在无 DB 时也应返回 200（database=false）
      const req = http.get(`${API_ORIGIN}/health`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve(true);
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`API 未在 ${timeoutMs}ms 内就绪：${API_ORIGIN}/health`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function spawnApiProcess(command, args, options) {
  apiChild = spawn(command, args, {
    ...options,
    stdio: "ignore",
    windowsHide: true,
  });
  apiSpawnedByUs = true;
  apiChild.on("exit", () => {
    apiChild = null;
    if (apiSpawnedByUs) {
      apiStatus = "failed";
      apiLastError = "后端进程已退出";
    }
    apiSpawnedByUs = false;
  });
}

function stopApi() {
  if (!apiSpawnedByUs || !apiChild) {
    apiChild = null;
    apiSpawnedByUs = false;
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(apiChild.pid), "/f", "/t"]);
    } else {
      apiChild.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  apiChild = null;
  apiSpawnedByUs = false;
}

async function startApiSynced() {
  if (apiChild) {
    apiStatus = "ready";
    return { ready: true, spawnedByUs: apiSpawnedByUs };
  }

  apiStatus = "starting";
  apiLastError = "";

  try {
    await waitForHealth(1500);
    apiSpawnedByUs = false;
    apiStatus = "ready";
    return { ready: true, spawnedByUs: false };
  } catch {
    /* need spawn */
  }

  const env = loadDotEnvInto({
    ...process.env,
    KONGKU_API_PORT: String(API_PORT),
  });

  const sidecar = apiSidecarPath();
  if (fs.existsSync(sidecar)) {
    spawnApiProcess(sidecar, [], { env });
    try {
      await waitForHealth(90000);
      apiStatus = "ready";
      return { ready: true, spawnedByUs: true };
    } catch (err) {
      apiStatus = "failed";
      apiLastError = String(err);
      stopApi();
      return { ready: false, spawnedByUs: false };
    }
  }

  if (!app.isPackaged) {
    const root = repoRoot();
    const uvicorn =
      process.platform === "win32"
        ? path.join(root, "apps", "api", ".venv", "Scripts", "uvicorn.exe")
        : path.join(root, "apps", "api", ".venv", "bin", "uvicorn");
    if (fs.existsSync(uvicorn)) {
      spawnApiProcess(
        uvicorn,
        [
          "app.main:app",
          "--app-dir",
          path.join(root, "apps", "api"),
          "--host",
          API_HOST,
          "--port",
          String(API_PORT),
        ],
        { cwd: path.join(root, "apps", "api"), env },
      );
      try {
        await waitForHealth(90000);
        apiStatus = "ready";
        return { ready: true, spawnedByUs: true };
      } catch (err) {
        apiStatus = "failed";
        apiLastError = String(err);
        stopApi();
        return { ready: false, spawnedByUs: false };
      }
    }
    apiStatus = "failed";
    apiLastError =
      "未找到 API：请先创建 apps/api/.venv 并安装依赖，或放置 resources/api/kongku-api";
    return { ready: false, spawnedByUs: false };
  }

  apiStatus = "failed";
  apiLastError = "安装包内缺少 API sidecar（resources/api）";
  return { ready: false, spawnedByUs: false };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 开发：默认连 Vite；可用 KONGKU_DEV_WEB 覆盖，设为空则用打包静态页逻辑
  if (!app.isPackaged) {
    const devUrl = process.env.KONGKU_DEV_WEB || DEV_WEB;
    if (devUrl) {
      await mainWindow.loadURL(devUrl);
      return;
    }
  }

  const indexHtml = webDistIndex();
  if (fs.existsSync(indexHtml)) {
    await mainWindow.loadFile(indexHtml);
  } else {
    await mainWindow.loadURL(API_ORIGIN);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("updater:available", info);
  });
  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send("updater:error", String(err));
  });
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 5000);

  ipcMain.handle("updater:download", async () => {
    await autoUpdater.downloadUpdate();
    return true;
  });
  ipcMain.handle("updater:install", () => {
    autoUpdater.quitAndInstall();
  });
}

app.whenReady().then(async () => {
  ipcMain.handle("kongku:getConfig", () => ({
    apiOrigin: API_ORIGIN,
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    apiStatus,
    apiLastError,
    apiSpawnedByUs,
  }));

  try {
    await startApiSynced();
  } catch (err) {
    apiStatus = "failed";
    apiLastError = String(err);
    console.warn("[kongku] API start:", err);
  }

  await createWindow();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopApi();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopApi();
});
