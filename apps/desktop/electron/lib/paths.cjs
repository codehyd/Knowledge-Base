/**
 * 路径与常量：开发 / 打包数据目录、sidecar、图标等。
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const ELECTRON_DIR = path.join(__dirname, "..");
const DESKTOP_DIR = path.join(ELECTRON_DIR, "..");

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.KONGKU_API_PORT || 18765);
const API_ORIGIN = `http://${API_HOST}:${API_PORT}`;
const DEV_WEB = process.env.KONGKU_DEV_WEB || "http://127.0.0.1:41779";

function repoRoot() {
  // apps/desktop/electron/lib -> 仓库根
  return path.resolve(DESKTOP_DIR, "..", "..");
}

function webDistIndex() {
  return path.join(process.resourcesPath, "web", "index.html");
}

function apiSidecarPath() {
  const bin = process.platform === "win32" ? "kongku-api.exe" : "kongku-api";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "api", bin);
  }
  return path.join(DESKTOP_DIR, "resources", "api", bin);
}

function appDataRoot() {
  return app.getPath("userData");
}

function ensureAppDataDir() {
  const dir = path.join(appDataRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 开发/打包统一的可写数据目录（与 API DATA_DIR 对齐） */
function runtimeDataDir() {
  if (app.isPackaged) return ensureAppDataDir();
  const dir = path.join(repoRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ytDlpCookiesPath() {
  return path.join(runtimeDataDir(), "yt-dlp-cookies.txt");
}

function sidecarLogPath() {
  return path.join(appDataRoot(), "api-sidecar.log");
}

function windowIconPath() {
  const localPng = path.join(ELECTRON_DIR, "icon.png");
  const buildIco = path.join(DESKTOP_DIR, "build", "icon.ico");
  const buildPng = path.join(DESKTOP_DIR, "build", "icon.png");
  if (app.isPackaged) {
    return fs.existsSync(localPng) ? localPng : undefined;
  }
  if (process.platform === "win32" && fs.existsSync(buildIco)) return buildIco;
  if (fs.existsSync(buildPng)) return buildPng;
  if (fs.existsSync(localPng)) return localPng;
  return undefined;
}

function preloadPath() {
  return path.join(ELECTRON_DIR, "preload.cjs");
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

module.exports = {
  ELECTRON_DIR,
  DESKTOP_DIR,
  API_HOST,
  API_PORT,
  API_ORIGIN,
  DEV_WEB,
  repoRoot,
  webDistIndex,
  apiSidecarPath,
  appDataRoot,
  ensureAppDataDir,
  runtimeDataDir,
  ytDlpCookiesPath,
  sidecarLogPath,
  windowIconPath,
  preloadPath,
  loadDotEnvInto,
};
