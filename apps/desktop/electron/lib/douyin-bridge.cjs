/**
 * 桌面端抖音抓取桥：用已登录的 persist:kongku-media 会话打开页面并下载音视频。
 * yt-dlp 的 Douyin 网页接口常因签名/风控失败，桌面端可走真实浏览器环境。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { BrowserWindow, net } = require("electron");

const { mediaSession, isHttpUrl, attachMediaLoginGuards } = require("./media.cjs");

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env.KONGKU_DESKTOP_BRIDGE_PORT || 18766);

/** @type {import('http').Server | null} */
let server = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractAwemeId(rawUrl) {
  const s = String(rawUrl || "");
  const m = s.match(/\/video\/(\d+)/);
  return m ? m[1] : "";
}

function pickMediaUrl(candidates) {
  const list = [...new Set(candidates.filter(Boolean))];
  const scored = list.map((u) => {
    let score = 0;
    if (/\.m4a(\?|$)/i.test(u)) score += 50;
    if (/\.mp3(\?|$)/i.test(u)) score += 45;
    if (/\.mp4(\?|$)/i.test(u)) score += 30;
    if (/douyinvod|bytevod|snssdk|amemv|ixigua/i.test(u)) score += 20;
    if (/play|audio|media/i.test(u)) score += 5;
    if (/\/tos\//i.test(u)) score += 5;
    return { u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.u || "";
}

function cleanPageTitle(title) {
  let t = String(title || "").trim();
  t = t.replace(/\s*[-_|]\s*抖音.*$/u, "").trim();
  t = t.replace(/^抖音\s*[-_|]\s*/u, "").trim();
  return t.slice(0, 200);
}

async function downloadUrlToFile(fileUrl, destPath, referer) {
  const ses = mediaSession();
  // Electron 30+ session.fetch；否则退回 net.request
  if (typeof ses.fetch === "function") {
    const res = await ses.fetch(fileUrl, {
      headers: {
        Referer: referer || "https://www.douyin.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) {
      throw new Error(`下载媒体失败 HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      throw new Error("下载到的媒体过小，可能不是有效音轨");
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return buf.length;
  }

  await new Promise((resolve, reject) => {
    const req = net.request({
      url: fileUrl,
      session: ses,
      headers: {
        Referer: referer || "https://www.douyin.com/",
      },
    });
    const chunks = [];
    req.on("response", (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`下载媒体失败 HTTP ${response.statusCode}`));
        return;
      }
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 1024) {
          reject(new Error("下载到的媒体过小，可能不是有效音轨"));
          return;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, buf);
        resolve(buf.length);
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchDouyinMedia(pageUrl, outDir) {
  const url = String(pageUrl || "").trim();
  if (!isHttpUrl(url)) {
    return { ok: false, message: "无效链接" };
  }
  const awemeId = extractAwemeId(url);
  const target =
    awemeId && /douyin\.com/i.test(url)
      ? `https://www.douyin.com/video/${awemeId}`
      : url;

  const ses = mediaSession();
  /** @type {string[]} */
  const candidates = [];
  const onCompleted = (details) => {
    const u = details.url || "";
    if (details.resourceType && !["xhr", "media", "other", "image"].includes(details.resourceType)) {
      // 仍检查 URL，部分媒体标成 xhr
    }
    if (
      /\.(mp4|m4a|mp3)(\?|$)/i.test(u) ||
      /douyinvod|bytevod|snssdk\.com|amemv\.com|ixigua\.com/i.test(u)
    ) {
      if ((details.statusCode || 0) >= 200 && (details.statusCode || 0) < 400) {
        candidates.push(u);
      }
    }
  };
  ses.webRequest.onCompleted({ urls: ["*://*/*"] }, onCompleted);

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      partition: "persist:kongku-media",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  attachMediaLoginGuards(win);

  try {
    await win.loadURL(target);
    // 等页面 XHR / 播放器请求
    await sleep(4500);
    try {
      await win.webContents.executeJavaScript(`
        (() => {
          const v = document.querySelector('video');
          if (v) { try { v.muted = true; void v.play(); } catch (e) {} }
          return true;
        })()
      `);
      await sleep(2500);
    } catch {
      /* ignore */
    }

    const meta = await win.webContents.executeJavaScript(`
      (() => {
        const title = document.title || '';
        const desc = document.querySelector('meta[name="description"]')?.content
          || document.querySelector('meta[property="og:description"]')?.content
          || '';
        const v = document.querySelector('video');
        const src = (v && (v.currentSrc || v.src)) || '';
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const found = [];
        const re = /https:\\/\\/[^"'\\s]+(?:douyinvod|bytevod|snssdk|amemv)[^"'\\s]*/gi;
        let m;
        while ((m = re.exec(html)) && found.length < 20) {
          found.push(m[0].replace(/\\\\u002F/g, '/').replace(/\\\\\\//g, '/'));
        }
        return { title, desc, src, found };
      })()
    `);

    if (meta?.src) candidates.unshift(meta.src);
    if (Array.isArray(meta?.found)) candidates.push(...meta.found);

    const mediaUrl = pickMediaUrl(candidates);
    if (!mediaUrl) {
      return {
        ok: false,
        message:
          "未捕获到音视频地址。请确认已在应用内登录抖音，并稍后再试；或改用「补贴文案」。",
        title: cleanPageTitle(meta?.title || ""),
        candidates: candidates.slice(0, 5),
      };
    }

    const ext = /\.m4a(\?|$)/i.test(mediaUrl)
      ? "m4a"
      : /\.mp3(\?|$)/i.test(mediaUrl)
        ? "mp3"
        : "mp4";
    const dest = path.join(String(outDir), `audio.${ext}`);
    const size = await downloadUrlToFile(mediaUrl, dest, target);
    return {
      ok: true,
      path: dest,
      size,
      media_url: mediaUrl,
      title: cleanPageTitle(meta?.title || ""),
      description: String(meta?.desc || "").slice(0, 500),
    };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  } finally {
    try {
      ses.webRequest.onCompleted({ urls: ["*://*/*"] }, null);
    } catch {
      /* ignore */
    }
    if (!win.isDestroyed()) win.destroy();
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function startDouyinBridge() {
  if (server) return bridgeOrigin();

  server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    };

    try {
      if (req.method === "GET" && req.url === "/health") {
        send(200, { ok: true, service: "kongku-desktop-bridge" });
        return;
      }
      if (req.method === "POST" && req.url === "/douyin/fetch") {
        const body = await readJson(req);
        const pageUrl = body.url || body.page_url || "";
        const outDir = body.out_dir || body.outDir || "";
        if (!pageUrl || !outDir) {
          send(400, { ok: false, message: "需要 url 与 out_dir" });
          return;
        }
        const result = await fetchDouyinMedia(pageUrl, outDir);
        send(result.ok ? 200 : 502, result);
        return;
      }
      send(404, { ok: false, message: "not found" });
    } catch (err) {
      send(500, { ok: false, message: String(err?.message || err) });
    }
  });

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`[kongku] desktop bridge http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  });
  server.on("error", (err) => {
    console.warn("[kongku] desktop bridge:", err?.message || err);
  });
  return bridgeOrigin();
}

function stopDouyinBridge() {
  if (!server) return;
  try {
    server.close();
  } catch {
    /* ignore */
  }
  server = null;
}

function bridgeOrigin() {
  return `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
}

module.exports = {
  startDouyinBridge,
  stopDouyinBridge,
  bridgeOrigin,
  fetchDouyinMedia,
  BRIDGE_PORT,
};
