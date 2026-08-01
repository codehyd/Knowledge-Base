/**
 * 版本升级后清掉 Chromium HTTP 缓存。
 * 桌面端前端固定走 http://127.0.0.1:端口，URL 不变时可能继续用旧 index.html。
 */

const { app, session } = require("electron");
const fs = require("fs");
const path = require("path");

const MARK_FILE = "last-ui-version.txt";

async function clearUiCacheIfVersionChanged() {
  if (!app.isPackaged) return;

  const markPath = path.join(app.getPath("userData"), MARK_FILE);
  const current = String(app.getVersion() || "").trim();
  let previous = "";
  try {
    previous = fs.readFileSync(markPath, "utf8").trim();
  } catch {
    previous = "";
  }

  if (previous && previous === current) return;

  try {
    await session.defaultSession.clearCache();
    // 清掉可能卡住的旧文档缓存；不删 cookies / localStorage（设置、笔记偏好还在）
    await session.defaultSession.clearStorageData({
      storages: ["cachestorage", "shadercache", "serviceworkers"],
    });
    console.log(
      `[kongku] cleared UI cache after version change: ${previous || "(none)"} -> ${current}`,
    );
  } catch (err) {
    console.warn("[kongku] clear UI cache failed:", err);
  }

  try {
    fs.mkdirSync(path.dirname(markPath), { recursive: true });
    fs.writeFileSync(markPath, current, "utf8");
  } catch (err) {
    console.warn("[kongku] write version mark failed:", err);
  }
}

module.exports = { clearUiCacheIfVersionChanged };
