/**
 * Electron 开发启动：必要时自动拉起 apps/web 的 Vite，再开桌面壳。
 * - cd apps/desktop && npm run dev  → Vite（可复用）+ Electron（Electron 再拉 Python）
 * - cd apps/web && npm run dev      → 只开网页，不启 Electron / 不强制起 Python
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const WEB_ORIGIN = process.env.KONGKU_DEV_WEB || "http://127.0.0.1:41779";
const DESKTOP_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.resolve(DESKTOP_ROOT, "..", "web");
const isWin = process.platform === "win32";

/** @type {import('child_process').ChildProcess | null} */
let viteChild = null;
/** @type {import('child_process').ChildProcess | null} */
let electronChild = null;
let spawnedViteByUs = false;
let shuttingDown = false;

function waitForHttp(url, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
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
        reject(new Error(`Vite 未在 ${timeoutMs}ms 内就绪：${url}`));
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function npmCmd() {
  return isWin ? "npm.cmd" : "npm";
}

function electronBin() {
  const local = path.join(
    DESKTOP_ROOT,
    "node_modules",
    ".bin",
    isWin ? "electron.cmd" : "electron",
  );
  return fs.existsSync(local) ? local : "electron";
}

function killTree(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try {
    if (isWin && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(electronChild);
  if (spawnedViteByUs) killTree(viteChild);
  setTimeout(() => process.exit(code), isWin ? 400 : 100);
}

async function ensureVite() {
  try {
    await waitForHttp(WEB_ORIGIN, 1500);
    console.log(`[kongku-dev] 复用已运行的 Vite：${WEB_ORIGIN}`);
    return;
  } catch {
    /* need start */
  }

  if (!fs.existsSync(path.join(WEB_ROOT, "package.json"))) {
    throw new Error(`找不到前端工程：${WEB_ROOT}`);
  }

  console.log(`[kongku-dev] 启动 Vite：${WEB_ROOT}`);
  viteChild = spawn(npmCmd(), ["run", "dev"], {
    cwd: WEB_ROOT,
    env: process.env,
    stdio: "inherit",
    shell: isWin,
    windowsHide: true,
  });
  spawnedViteByUs = true;
  viteChild.on("exit", (code) => {
    viteChild = null;
    if (!shuttingDown && code && code !== 0) {
      console.error(`[kongku-dev] Vite 退出，code=${code}`);
      shutdown(code);
    }
  });

  await waitForHttp(WEB_ORIGIN, 120000);
  console.log(`[kongku-dev] Vite 已就绪：${WEB_ORIGIN}`);
}

function startElectron() {
  console.log("[kongku-dev] 启动 Electron");
  const bin = electronBin();
  electronChild = spawn(
    bin,
    [
      ".",
      "--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbars",
    ],
    {
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        KONGKU_DEV_WEB: WEB_ORIGIN,
      },
      stdio: "inherit",
      shell: isWin,
      windowsHide: false,
    },
  );
  electronChild.on("exit", (code) => {
    electronChild = null;
    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

(async () => {
  try {
    await ensureVite();
    startElectron();
  } catch (err) {
    console.error("[kongku-dev]", err);
    shutdown(1);
  }
})();
