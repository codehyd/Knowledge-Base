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

/** 打包后用户可写目录（勿写安装目录 Program Files） */
function appDataRoot() {
  return app.getPath("userData");
}

function ensureAppDataDir() {
  const dir = path.join(appDataRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sidecarLogPath() {
  return path.join(appDataRoot(), "api-sidecar.log");
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
  /** @type {import('child_process').SpawnOptions} */
  const opts = {
    ...options,
    windowsHide: true,
  };
  // 打包态把 sidecar 日志写到 userData，便于排查「有进程无窗口」
  if (app.isPackaged) {
    try {
      const log = sidecarLogPath();
      const fd = fs.openSync(log, "a");
      opts.stdio = ["ignore", fd, fd];
    } catch {
      opts.stdio = "ignore";
    }
  } else {
    opts.stdio = "ignore";
  }

  apiChild = spawn(command, args, opts);
  apiSpawnedByUs = true;
  apiChild.on("exit", (code) => {
    apiChild = null;
    if (apiSpawnedByUs) {
      apiStatus = "failed";
      apiLastError = `后端进程已退出${code != null ? ` (code=${code})` : ""}`;
    }
    apiSpawnedByUs = false;
  });
  apiChild.on("error", (err) => {
    apiStatus = "failed";
    apiLastError = `后端启动失败：${err.message}`;
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

  const dataDir = app.isPackaged ? ensureAppDataDir() : undefined;
  const env = loadDotEnvInto({
    ...process.env,
    KONGKU_API_PORT: String(API_PORT),
    KONGKU_API_HOST: API_HOST,
    ...(dataDir ? { DATA_DIR: dataDir } : {}),
  });

  const sidecar = apiSidecarPath();
  if (fs.existsSync(sidecar)) {
    spawnApiProcess(sidecar, [], {
      env,
      cwd: app.isPackaged ? appDataRoot() : undefined,
    });
    try {
      // 窗口已并行打开；此处最多等 45s，失败也不阻塞界面
      await waitForHealth(45000);
      apiStatus = "ready";
      return { ready: true, spawnedByUs: true };
    } catch (err) {
      apiStatus = "failed";
      apiLastError = String(err);
      // 不立刻 kill：留给用户看界面提示；超时后再清
      return { ready: false, spawnedByUs: apiSpawnedByUs };
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

function windowIconPath() {
  const localPng = path.join(__dirname, "icon.png");
  const buildIco = path.join(__dirname, "..", "build", "icon.ico");
  const buildPng = path.join(__dirname, "..", "build", "icon.png");
  // 打包后 asar 内只有 electron/icon.png；开发态可用 build 下 ico/png
  if (app.isPackaged) {
    return fs.existsSync(localPng) ? localPng : undefined;
  }
  if (process.platform === "win32" && fs.existsSync(buildIco)) return buildIco;
  if (fs.existsSync(buildPng)) return buildPng;
  if (fs.existsSync(localPng)) return localPng;
  return undefined;
}

async function createWindow() {
  const icon = windowIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const reveal = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  };
  mainWindow.once("ready-to-show", reveal);
  // Windows 上偶发 ready-to-show 不触发；强制露出窗口避免「只有进程没界面」
  setTimeout(reveal, 2500);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.warn("[kongku] did-fail-load", code, desc, url);
    reveal();
  });

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
    dataDir: app.isPackaged ? path.join(appDataRoot(), "data") : undefined,
  }));

  // 先开窗口，再并行拉 API，避免 Win 上长时间「有进程无界面」
  const apiPromise = startApiSynced().catch((err) => {
    apiStatus = "failed";
    apiLastError = String(err);
    console.warn("[kongku] API start:", err);
  });

  try {
    await createWindow();
  } catch (err) {
    console.error("[kongku] createWindow:", err);
  }

  await apiPromise;
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
