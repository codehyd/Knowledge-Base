/**
 * 本机 API：开发态 uvicorn / 打包态 sidecar。
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execSync } = require("child_process");

const state = require("./state.cjs");
const { waitForHttp } = require("./http-wait.cjs");
const {
  API_HOST,
  API_PORT,
  API_ORIGIN,
  repoRoot,
  apiSidecarPath,
  appDataRoot,
  runtimeDataDir,
  ytDlpCookiesPath,
  sidecarLogPath,
  loadDotEnvInto,
} = require("./paths.cjs");

function waitForHealth(timeoutMs = 90000) {
  return waitForHttp(`${API_ORIGIN}/health`, timeoutMs, "API", {
    okStatuses: [200],
  });
}

/** GET JSON；超时/失败抛错。用于识别旧版孤儿 API。 */
function httpGetJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }
        resolve({ status: res.statusCode || 0, data, raw });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
  });
}

/** 清理会污染 PyInstaller/子进程的 Electron 运行环境变量 */
function sanitizeSidecarEnv(baseEnv) {
  const env = { ...baseEnv };

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

  // 默认清掉代理：Clash 等会让抖音抓取 403，再被 yt-dlp 误报成 Fresh cookies
  // 需要代理时：启动前设 KONGKU_KEEP_PROXY=1，或 KONGKU_YTDLP_PROXY=...
  if (process.env.KONGKU_KEEP_PROXY !== "1") {
    for (const key of Object.keys(env)) {
      if (/^(https?|all|socks5?)_?proxy$/i.test(key)) {
        delete env[key];
      }
    }
  }

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

function spawnApiProcess(command, args, options) {
  /** @type {import('child_process').SpawnOptions} */
  const opts = {
    ...options,
    env: sanitizeSidecarEnv(options?.env || process.env),
    windowsHide: true,
    shell: false,
  };
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
  state.apiChild = spawn(command, args, opts);
  state.apiSpawnedByUs = true;
  state.apiChild.on("exit", (code, signal) => {
    state.apiChild = null;
    if (state.apiSpawnedByUs && !state.apiStoppingIntentionally) {
      state.apiStatus = "failed";
      state.apiLastError = `后端进程已退出${code != null ? ` (code=${code})` : ""}${
        signal ? ` signal=${signal}` : ""
      }；日志：${log}`;
      console.warn("[kongku]", state.apiLastError);
    }
    state.apiSpawnedByUs = false;
    state.apiStoppingIntentionally = false;
  });
  state.apiChild.on("error", (err) => {
    state.apiStatus = "failed";
    state.apiLastError = `后端启动失败：${err.message}；日志：${log}`;
    console.error("[kongku]", state.apiLastError);
  });
}

function stopApi() {
  if (!state.apiSpawnedByUs || !state.apiChild) {
    state.apiChild = null;
    state.apiSpawnedByUs = false;
    return;
  }
  state.apiStoppingIntentionally = true;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(state.apiChild.pid), "/f", "/t"]);
    } else {
      state.apiChild.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  state.apiChild = null;
  state.apiSpawnedByUs = false;
}

/**
 * 端口上已有 API 时，仅在「带笔记库/技能路由」时复用。
 * 升级后常见：旧 kongku-api 孤儿仍占 18765，新前端点笔记 → Not Found / Method Not Allowed。
 */
async function canReuseExternalApi() {
  if (process.env.KONGKU_FORCE_SIDECAR === "1") return false;
  try {
    // 端口无人监听时尽快失败（勿用长 timeout 空等）
    const health = await httpGetJson(`${API_ORIGIN}/health`, 600);
    if (health.status !== 200 || !health.data?.ok) return false;

    const features = Array.isArray(health.data.features)
      ? health.data.features
      : [];
    if (features.includes("vault") && features.includes("skills")) {
      return true;
    }

    // 旧版 health 无 features：轻量探路由（勿扫整棵 vault tree）
    const skills = await httpGetJson(`${API_ORIGIN}/api/skills`, 800);
    if (skills.status !== 200) {
      console.warn(
        "[kongku] 端口上的 API 无 /api/skills（status=",
        skills.status,
        "），将替换为本版 sidecar",
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 清掉占用 18765 的监听进程（开发孤儿 uvicorn / 升级残留 sidecar） */
function killStaleApiListeners() {
  const selfPid = process.pid;
  const childPid = state.apiChild?.pid;

  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano | findstr :${API_PORT}`, {
        encoding: "utf8",
        windowsHide: true,
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = /(\d+)\s*$/.exec(line.trim());
        if (!m) continue;
        const pid = Number(m[1]);
        if (!pid || pid === selfPid || pid === childPid) continue;
        pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, {
            encoding: "utf8",
            windowsHide: true,
            stdio: "ignore",
          });
          console.warn("[kongku] 已结束占用端口的旧 API 进程 pid=", pid);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 无监听或 netstat 失败 */
    }
    return;
  }

  try {
    const out = execSync(
      `lsof -ti tcp:${API_PORT} -sTCP:LISTEN 2>/dev/null || true`,
      { encoding: "utf8" },
    ).trim();
    if (!out) return;
    for (const pidText of out.split(/\s+/)) {
      const pid = Number(pidText);
      if (!pid || pid === selfPid || pid === childPid) continue;
      try {
        process.kill(pid, "SIGTERM");
        console.warn("[kongku] 已结束占用端口的旧 API 进程 pid=", pid);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function buildApiEnv() {
  const dataDir = runtimeDataDir();
  let appVersion = "";
  try {
    appVersion = String(app.getVersion() || "");
  } catch {
    appVersion = "";
  }
  const env = loadDotEnvInto({
    ...process.env,
    KONGKU_API_PORT: String(API_PORT),
    KONGKU_API_HOST: API_HOST,
    KONGKU_DESKTOP: "1",
    KONGKU_APP_VERSION: appVersion,
    DATA_DIR: dataDir,
    KONGKU_YTDLP_COOKIES: ytDlpCookiesPath(),
    // API 抖音抓取失败时，回调桌面端用已登录会话下媒体
    KONGKU_DESKTOP_BRIDGE: `http://127.0.0.1:${
      Number(process.env.KONGKU_DESKTOP_BRIDGE_PORT || 18766)
    }`,
  });
  if (process.env.KONGKU_USE_ENV_DB !== "1") {
    delete env.DATABASE_URL;
    const dbFile = path.resolve(dataDir, "kongku.db").replace(/\\/g, "/");
    env.DATABASE_URL = `sqlite+aiosqlite:///${dbFile}`;
  }
  if (app.isPackaged) {
    const webDir = path.join(process.resourcesPath, "web");
    if (fs.existsSync(webDir)) {
      env.KONGKU_WEB_DIR = webDir;
    }
  }
  return env;
}

async function startDevUvicorn(root, env) {
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

  if (!command) {
    state.apiStatus = "failed";
    state.apiLastError =
      "未找到 API：请先创建 apps/api/.venv 并 pip install -r requirements.txt";
    console.error("[kongku]", state.apiLastError);
    return { ready: false, spawnedByUs: false };
  }

  spawnApiProcess(command, args, {
    cwd: path.join(root, "apps", "api"),
    env,
  });
  try {
    await waitForHealth(90000);
    state.apiStatus = "ready";
    console.log("[kongku] API ready (uvicorn):", API_ORIGIN, "db=", env.DATABASE_URL);
    return { ready: true, spawnedByUs: true };
  } catch (err) {
    state.apiStatus = "failed";
    state.apiLastError = `${err}；请查看 data/api-dev.log，并确认已 pip install -r apps/api/requirements.txt（含 aiosqlite）`;
    console.error("[kongku]", state.apiLastError);
    stopApi();
    return { ready: false, spawnedByUs: false };
  }
}

async function startPackagedSidecar(env) {
  const sidecar = apiSidecarPath();
  console.log(
    "[kongku] sidecar path:",
    sidecar,
    "exists=",
    fs.existsSync(sidecar),
  );
  if (!fs.existsSync(sidecar)) {
    state.apiStatus = "failed";
    state.apiLastError = "安装包内缺少 API sidecar（resources/api）";
    return { ready: false, spawnedByUs: false };
  }

  ensureSidecarExecutable(sidecar);
  spawnApiProcess(sidecar, [], {
    env,
    cwd: appDataRoot(),
  });
  try {
    await waitForHealth(90000);
    state.apiStatus = "ready";
    console.log("[kongku] API ready (sidecar):", API_ORIGIN);
    return { ready: true, spawnedByUs: true };
  } catch (err) {
    state.apiStatus = "failed";
    state.apiLastError = `${String(err)}；请查看日志：${sidecarLogPath()}`;
    return { ready: false, spawnedByUs: state.apiSpawnedByUs };
  }
}

async function startApiSynced() {
  if (state.apiChild) {
    state.apiStatus = "ready";
    return { ready: true, spawnedByUs: state.apiSpawnedByUs };
  }

  state.apiStatus = "starting";
  state.apiLastError = "";

  // 仅复用「带笔记库/技能」的已运行 API；否则杀掉占端口的旧进程再拉起本版
  if (await canReuseExternalApi()) {
    state.apiSpawnedByUs = false;
    state.apiStatus = "ready";
    console.log("[kongku] 复用已运行的本机 API:", API_ORIGIN);
    return { ready: true, spawnedByUs: false };
  }

  killStaleApiListeners();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const env = buildApiEnv();
  if (!app.isPackaged) {
    return startDevUvicorn(repoRoot(), env);
  }
  return startPackagedSidecar(env);
}

module.exports = {
  waitForHealth,
  startApiSynced,
  stopApi,
};
