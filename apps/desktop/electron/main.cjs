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

const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

// 关闭 Fluent/Overlay 滚动条，避免忽略页面 ::-webkit-scrollbar 自定义样式
app.commandLine.appendSwitch(
  "disable-features",
  "OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbars",
);

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

/** 清理会污染 PyInstaller/子进程的 Electron 运行环境变量 */
function sanitizeSidecarEnv(baseEnv) {
  const env = { ...baseEnv };

  // 各平台 Electron 都可能注入这些，导致 sidecar 加载到错误的动态库
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.ELECTRON_RUN_AS_NODE;

  if (process.platform === "linux") {
    delete env.LD_LIBRARY_PATH;
    delete env.LD_PRELOAD;
  }

  if (process.platform === "darwin") {
    delete env.DYLD_LIBRARY_PATH;
    delete env.DYLD_INSERT_LIBRARIES;
    delete env.DYLD_FALLBACK_LIBRARY_PATH;
    delete env.DYLD_FRAMEWORK_PATH;
  }

  // PyInstaller onefile 解压目录：避免系统临时目录 noexec / 权限问题
  if (app.isPackaged) {
    const tmp = path.join(appDataRoot(), "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    env.TMPDIR = tmp;
    env.TEMP = tmp;
    env.TMP = tmp;
  }
  return env;
}

function ensureSidecarExecutable(sidecarPath) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(sidecarPath, 0o755);
  } catch (err) {
    console.warn("[kongku] chmod sidecar failed:", err);
  }
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

function waitForHttp(url, timeoutMs = 60000, label = "服务", { okStatuses } = {}) {
  const started = Date.now();
  const allow = Array.isArray(okStatuses) && okStatuses.length
    ? new Set(okStatuses)
    : null;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        const code = res.statusCode || 0;
        const ok = allow ? allow.has(code) : code > 0 && code < 500;
        if (ok) {
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
        reject(new Error(`${label}未在 ${timeoutMs}ms 内就绪：${url}`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function waitForHealth(timeoutMs = 90000) {
  // /health 在无 DB 时也应返回 200（database=false）
  return waitForHttp(`${API_ORIGIN}/health`, timeoutMs, "API", {
    okStatuses: [200],
  });
}

function spawnApiProcess(command, args, options) {
  /** @type {import('child_process').SpawnOptions} */
  const opts = {
    ...options,
    env: sanitizeSidecarEnv(options?.env || process.env),
    windowsHide: true,
    shell: false,
  };
  // 开发/打包都写日志，避免子进程静默退出后无法排查
  const log = app.isPackaged
    ? sidecarLogPath()
    : path.join(repoRoot(), "data", "api-dev.log");
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, "a");
    fs.writeSync(
      fd,
      `\n==== ${new Date().toISOString()} spawn ${command} ${args.join(" ")}\n` +
        `cwd=${opts.cwd || ""}\n` +
        `platform=${process.platform} packaged=${app.isPackaged}\n`,
    );
    opts.stdio = ["ignore", fd, fd];
  } catch {
    opts.stdio = app.isPackaged ? "ignore" : "inherit";
  }

  console.log("[kongku] spawn API:", command, args.join(" "));
  apiChild = spawn(command, args, opts);
  apiSpawnedByUs = true;
  apiChild.on("exit", (code, signal) => {
    apiChild = null;
    if (apiSpawnedByUs) {
      apiStatus = "failed";
      apiLastError = `后端进程已退出${code != null ? ` (code=${code})` : ""}${
        signal ? ` signal=${signal}` : ""
      }；日志：${log}`;
      console.warn("[kongku]", apiLastError);
    }
    apiSpawnedByUs = false;
  });
  apiChild.on("error", (err) => {
    apiStatus = "failed";
    apiLastError = `后端启动失败：${err.message}；日志：${log}`;
    console.error("[kongku]", apiLastError);
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

  const root = repoRoot();
  const dataDir = app.isPackaged
    ? ensureAppDataDir()
    : (() => {
        const dir = path.join(root, "data");
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      })();

  // Electron 拉起的 API：默认 SQLite（不依赖本机 Docker Postgres）
  // 若要强制用仓库 .env 里的 Postgres：启动前设 KONGKU_USE_ENV_DB=1
  const env = loadDotEnvInto({
    ...process.env,
    KONGKU_API_PORT: String(API_PORT),
    KONGKU_API_HOST: API_HOST,
    KONGKU_DESKTOP: "1",
    DATA_DIR: dataDir,
  });
  if (process.env.KONGKU_USE_ENV_DB !== "1") {
    delete env.DATABASE_URL;
    // Windows 也用正斜杠；盘符路径保持 sqlite+aiosqlite:///C:/...
    const dbFile = path.resolve(dataDir, "kongku.db").replace(/\\/g, "/");
    env.DATABASE_URL = `sqlite+aiosqlite:///${dbFile}`;
  }

  if (app.isPackaged) {
    const webDir = path.join(process.resourcesPath, "web");
    if (fs.existsSync(webDir)) {
      env.KONGKU_WEB_DIR = webDir;
    }
  }

  const sidecar = apiSidecarPath();
  console.log("[kongku] sidecar path:", sidecar, "exists=", fs.existsSync(sidecar));
  if (fs.existsSync(sidecar)) {
    ensureSidecarExecutable(sidecar);
    spawnApiProcess(sidecar, [], {
      env,
      cwd: app.isPackaged ? appDataRoot() : path.join(root, "apps", "api"),
    });
    try {
      // Win / Mac / Linux：onefile 冷启动与杀软扫描都可能较慢
      await waitForHealth(90000);
      apiStatus = "ready";
      console.log("[kongku] API ready (sidecar):", API_ORIGIN);
      return { ready: true, spawnedByUs: true };
    } catch (err) {
      apiStatus = "failed";
      const logHint = app.isPackaged ? sidecarLogPath() : path.join(root, "data", "api-dev.log");
      apiLastError = `${String(err)}；请查看日志：${logHint}`;
      return { ready: false, spawnedByUs: apiSpawnedByUs };
    }
  }

  if (!app.isPackaged) {
    const uvicorn =
      process.platform === "win32"
        ? path.join(root, "apps", "api", ".venv", "Scripts", "uvicorn.exe")
        : path.join(root, "apps", "api", ".venv", "bin", "uvicorn");
    const py =
      process.platform === "win32"
        ? path.join(root, "apps", "api", ".venv", "Scripts", "python.exe")
        : path.join(root, "apps", "api", ".venv", "bin", "python");

    let command = "";
    /** @type {string[]} */
    let args = [];
    if (fs.existsSync(uvicorn)) {
      command = uvicorn;
      args = [
        "app.main:app",
        "--app-dir",
        path.join(root, "apps", "api"),
        "--host",
        API_HOST,
        "--port",
        String(API_PORT),
      ];
    } else if (fs.existsSync(py)) {
      command = py;
      args = [
        "-m",
        "uvicorn",
        "app.main:app",
        "--app-dir",
        path.join(root, "apps", "api"),
        "--host",
        API_HOST,
        "--port",
        String(API_PORT),
      ];
    }

    if (command) {
      spawnApiProcess(command, args, {
        cwd: path.join(root, "apps", "api"),
        env,
      });
      try {
        await waitForHealth(90000);
        apiStatus = "ready";
        console.log("[kongku] API ready (uvicorn):", API_ORIGIN, "db=", env.DATABASE_URL);
        return { ready: true, spawnedByUs: true };
      } catch (err) {
        apiStatus = "failed";
        apiLastError = `${err}；请查看 data/api-dev.log，并确认已 pip install -r apps/api/requirements.txt（含 aiosqlite）`;
        console.error("[kongku]", apiLastError);
        stopApi();
        return { ready: false, spawnedByUs: false };
      }
    }
    apiStatus = "failed";
    apiLastError =
      "未找到 API：请先创建 apps/api/.venv 并 pip install -r requirements.txt";
    console.error("[kongku]", apiLastError);
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
  // 去掉系统默认 File / Edit / View 菜单栏
  Menu.setApplicationMenu(null);

  const icon = windowIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
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

  // 开发：默认连 Vite（网页端同样用这份 Vite）；仅 Electron 负责拉起 Python
  // 可用 KONGKU_DEV_WEB 覆盖；设为空字符串则走下方打包静态页逻辑
  if (!app.isPackaged) {
    const devUrl =
      process.env.KONGKU_DEV_WEB === undefined
        ? DEV_WEB
        : process.env.KONGKU_DEV_WEB;
    if (devUrl) {
      try {
        console.log(`[kongku] 等待 Vite：${devUrl}`);
        await waitForHttp(devUrl, 90000, "Vite");
        await mainWindow.loadURL(devUrl);
      } catch (err) {
        console.error("[kongku] Vite 未就绪:", err);
        const tip = `<!doctype html><meta charset="utf-8"/><title>空库</title>
<body style="font-family:sans-serif;padding:40px;line-height:1.6;color:#1f2933;background:#f7f8f9">
<h1>前端 Vite 未启动</h1>
<p>Electron 开发态需要先开网页 Vite（端口 41779），再开桌面壳。</p>
<p>请另开终端执行：</p>
<pre style="background:#fff;padding:12px;border:1px solid #e6eaee;border-radius:8px">cd apps/web
npm run dev</pre>
<p>或一键：<code>scripts/dev-electron.ps1</code> / <code>scripts/dev-electron.sh</code></p>
<p style="color:#6b7280">${String(err).replace(/[<>&]/g, "")}</p>
</body>`;
        await mainWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(tip)}`,
        );
      }
      return;
    }
  }

  // 打包态：优先走本机 API 同源页面（避免 file:// CORS → Failed to fetch）
  // 若 API 尚未就绪，先显示启动页，由 loadAppUi 在 API ready 后再跳转
  await mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"/>
<title>空库</title>
<body style="font-family:sans-serif;padding:48px;color:#1f2933;background:#f7f8f9;line-height:1.6">
<h1 style="margin:0 0 12px">空库启动中…</h1>
<p style="margin:0;color:#6b7280">正在拉起本机服务，首次启动可能需要几十秒。</p>
</body>`)}`,
  );
}

async function loadAppUi() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!app.isPackaged) return;

  try {
    // 必须是 200 的首页（确认静态资源已挂载），避免把 FastAPI 404 当成成功
    await waitForHttp(`${API_ORIGIN}/`, 15000, "Web", { okStatuses: [200] });
    await mainWindow.loadURL(`${API_ORIGIN}/`);
    console.log("[kongku] UI loaded from API origin");
    return;
  } catch (err) {
    console.warn("[kongku] API 未托管前端，回退 loadFile:", err);
  }

  const indexHtml = webDistIndex();
  if (fs.existsSync(indexHtml)) {
    await mainWindow.loadFile(indexHtml);
  } else {
    await mainWindow.loadURL(API_ORIGIN);
  }
}

function softenUpdaterError(msg) {
  const text = String(msg || "");
  if (/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(text)) {
    return "下载更新时网络中断（GitHub 大文件在国内易断开）。请重试，或改用浏览器手动下载安装包。";
  }
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    ipcMain.handle("updater:check", async () => ({
      ok: false,
      reason: "dev",
      message: "开发模式不检查更新，请使用安装包验证",
    }));
    ipcMain.handle("updater:open-releases", async () => {
      await shell.openExternal(
        "https://github.com/codehyd/Knowledge-Base/releases/latest",
      );
      return true;
    });
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
    ipcMain.handle("updater:open-releases", async () => {
      await shell.openExternal(
        "https://github.com/codehyd/Knowledge-Base/releases/latest",
      );
      return true;
    });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // 大包差分更新更容易因 blockmap/网络中断失败，直接拉完整安装包更稳
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("updater:available", {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    mainWindow?.webContents.send("updater:not-available", {
      version: info.version,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("updater:progress", {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("updater:downloaded", {
      version: info.version,
    });
  });
  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send(
      "updater:error",
      softenUpdaterError(err?.message || err),
    );
  });

  // 启动稍后静默检查一次
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
      mainWindow?.webContents.send("updater:error", message);
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
    mainWindow?.webContents.send("updater:error", message);
    throw new Error(message);
  });

  ipcMain.handle("updater:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("updater:open-releases", async (_event, version) => {
    const ver = typeof version === "string" ? version.trim().replace(/^v/, "") : "";
    const url = ver
      ? `https://github.com/codehyd/Knowledge-Base/releases/tag/v${ver}`
      : "https://github.com/codehyd/Knowledge-Base/releases/latest";
    await shell.openExternal(url);
    return true;
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

  // 先开窗口（显示启动中），再拉 API；就绪后同源加载 UI，避免 Win 上长时间无界面 + file:// CORS
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
    app.quit();
  }
});

app.on("before-quit", () => {
  stopApi();
});
