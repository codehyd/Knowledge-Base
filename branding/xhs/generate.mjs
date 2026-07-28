#!/usr/bin/env node
/**
 * 从本机运行的空库 Web 预览截图，合成小红书推广图（1024×1536）。
 * 前置：apps/desktop npm run dev 或 apps/web npm run dev + API 18765
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;
const BASE = process.env.KONGKU_WEB_URL || "http://127.0.0.1:41779";
const VIEWPORT = { width: 1360, height: 860 };

const CARDS = [
  {
    file: "xhs-01-cover-desktop.png",
    variant: "cover",
    title: "Vibecoding",
    titleLine2: "做了个桌面知识库",
    subtitle: "Electron · 默认空库 · 自备 API Key",
    route: "/",
    features: [
      { icon: "🌱", title: "空库起步", desc: "从投递开始构建专属知识库" },
      { icon: "▶", title: "视频自动提取文案", desc: "链接或本地上传，ffmpeg + 转写" },
      { icon: "🛡", title: "只按库内答", desc: "超出范围拒答，减少幻觉" },
    ],
    footer: "超出范围会拒答 · 不预装通识百科",
  },
  {
    file: "xhs-02-feed-desktop.png",
    title: "喂养知识：投递材料",
    subtitle: "电子书 · 笔记 · 视频链接 · 本地上传转写",
    route: "/feed",
    features: [
      { icon: "📄", title: "PDF / EPUB", desc: "电子书自动抽取正文" },
      { icon: "📝", title: "Markdown 笔记", desc: "粘贴或上传" },
      { icon: "🔗", title: "视频链接", desc: "字幕 / 音轨转写" },
    ],
    footer: "电子书 · 笔记 · 视频 · 自动抽文案",
  },
  {
    file: "xhs-03-chat-desktop.png",
    title: "对话：只按库内作答",
    subtitle: "检索你的知识 · 引用可溯源 · 超出范围拒答",
    route: "/chat",
    features: [
      { icon: "✓", title: "库内检索", desc: "只基于已入库材料" },
      { icon: "📎", title: "引用出处", desc: "点击跳原文高亮" },
      { icon: "🛡", title: "拒答机制", desc: "减少幻觉与误答" },
    ],
    footer: "超出范围会拒答 · 引用可点回原文",
  },
  {
    file: "xhs-04-classify-desktop.png",
    title: "原文预览：划选高亮笔记",
    subtitle: "对话引用定位 · 确认后加入正式笔记",
    route: "/knowledge",
    afterNavigate: async (page) => {
      const item = page.locator("ul li button strong").first();
      await item.waitFor({ state: "visible", timeout: 15000 });
      await item.locator("xpath=ancestor::button[1]").click();
      await page.waitForTimeout(800);
      const previewBtn = page.getByRole("button", { name: "预览正文" });
      if (await previewBtn.count()) {
        await previewBtn.click();
        await page.waitForTimeout(1200);
      }
    },
    shotSelector: ".ant-modal-wrap:visible, [class*='shell']",
    features: [
      { icon: "🖍", title: "划选高亮", desc: "多色标记原文片段" },
      { icon: "💬", title: "对话预笔记", desc: "引用一键定位原文" },
      { icon: "✓", title: "确认入库", desc: "人工确认后加入笔记" },
    ],
    footer: "划选预览 · 笔记可溯源",
  },
  {
    file: "xhs-05-settings-desktop.png",
    title: "设置：自备模型 Key",
    subtitle: "Key 只存本机 · 对话 / 转写 / 嵌入可配",
    route: "/settings",
    features: [
      { icon: "🔑", title: "DeepSeek 等", desc: "OpenAI 兼容接口" },
      { icon: "🎙", title: "视频语音转写", desc: "本地 Whisper 或云端" },
      { icon: "💾", title: "本地 SQLite", desc: "数据留在本机" },
    ],
    footer: "Key 只存本机 · 不上传云端",
  },
  {
    file: "xhs-06-knowledge-desktop.png",
    title: "知识浏览：分类看条目",
    subtitle: "个人知识库 · 分类清晰 · 跟读与预览",
    route: "/knowledge",
    afterNavigate: async (page) => {
      const item = page.locator("ul li button strong").first();
      await item.waitFor({ state: "visible", timeout: 15000 });
      await item.locator("xpath=ancestor::button[1]").click();
      await page.waitForTimeout(900);
    },
    features: [
      { icon: "📚", title: "分类筛选", desc: "按标签快速定位" },
      { icon: "▶", title: "视频跟读", desc: "文案 + 音轨同步" },
      { icon: "🔍", title: "全文搜索", desc: "标题摘要一键搜" },
    ],
    footer: "你喂什么 · 它懂什么",
  },
  {
    file: "xhs-07-feedback-cta.png",
    variant: "cta",
    title: "求建议 · 一起打磨",
    subtitle: "这是我用 Vibecoding 搭的桌面知识库",
    subtitle2: "欢迎提意见 / 想要的功能 / 后续方向",
    route: "/",
    features: [],
    footer: "空库 KONGKU · 个人认知知识库",
  },
];

function buildHtml(card, screenshotB64) {
  const accent = "#2a6f6a";
  const bg = "linear-gradient(165deg, #f7f5f1 0%, #eef2f0 45%, #e8eeec 100%)";
  const features = (card.features || [])
    .map(
      (f) => `
      <div class="feat">
        <div class="feat-icon">${f.icon}</div>
        <div class="feat-text">
          <strong>${f.title}</strong>
          <span>${f.desc}</span>
        </div>
      </div>`,
    )
    .join("");

  const titleBlock =
    card.variant === "cover"
      ? `<div class="cover-title">
          <div class="cover-en">${card.title}</div>
          <div class="cover-zh">${card.titleLine2 || ""}</div>
          <div class="cover-sub">${card.subtitle || ""}</div>
        </div>`
      : card.variant === "cta"
        ? `<div class="cta-title">
            <div class="cta-logo"><img src="data:image/png;base64,${logoB64()}" alt="空库"/></div>
            <div class="cta-h1">${card.title}</div>
            <div class="cta-sub">${card.subtitle || ""}</div>
            <div class="cta-sub2">${card.subtitle2 || ""}</div>
          </div>`
        : `<div class="head">
            <h1>${card.title}</h1>
            <p>${card.subtitle || ""}</p>
          </div>`;

  const shotBlock =
    card.variant === "cta"
      ? `<div class="cta-shot"><img src="data:image/png;base64,${screenshotB64}" alt="app"/></div>`
      : `<div class="shot-wrap"><img class="shot" src="data:image/png;base64,${screenshotB64}" alt="app"/></div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600;700&display=swap" rel="stylesheet"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1024px; height: 1536px; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
    background: ${bg};
    color: #1f2937;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 56px 48px 40px;
    position: relative;
  }
  body::before, body::after {
    content: '';
    position: absolute;
    width: 280px; height: 280px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(42,111,106,0.08) 0%, transparent 70%);
    pointer-events: none;
  }
  body::before { top: -40px; left: -60px; }
  body::after { bottom: 80px; right: -80px; }
  .head { text-align: center; margin-bottom: 28px; z-index: 1; }
  .head h1 {
    font-family: 'Noto Serif SC', 'Songti SC', serif;
    font-size: 52px; font-weight: 700; color: ${accent};
    letter-spacing: 0.02em; line-height: 1.15;
  }
  .head p { margin-top: 12px; font-size: 22px; color: #64748b; }
  .cover-title { text-align: center; margin-bottom: 24px; z-index: 1; }
  .cover-en {
    font-family: 'Noto Serif SC', serif;
    font-size: 58px; font-weight: 700; color: ${accent};
  }
  .cover-zh {
    font-family: 'Noto Serif SC', serif;
    font-size: 44px; font-weight: 600; color: ${accent};
    margin-top: 6px;
  }
  .cover-sub { margin-top: 14px; font-size: 20px; color: #64748b; }
  .cta-title { text-align: center; margin-bottom: 20px; z-index: 1; }
  .cta-logo img { height: 44px; width: auto; }
  .cta-h1 {
    font-family: 'Noto Serif SC', serif;
    font-size: 48px; font-weight: 700; color: ${accent};
    margin-top: 16px;
  }
  .cta-sub { margin-top: 14px; font-size: 20px; color: #475569; }
  .cta-sub2 { margin-top: 8px; font-size: 18px; color: #64748b; }
  .shot-wrap {
    flex: 1; display: flex; align-items: center; justify-content: center;
    width: 100%; z-index: 1; min-height: 0;
  }
  .shot {
    max-width: 100%; max-height: 920px; width: auto; height: auto;
    border-radius: 14px;
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.14), 0 4px 16px rgba(15, 23, 42, 0.08);
    border: 1px solid rgba(255,255,255,0.8);
  }
  .cta-shot {
    flex: 1; display: flex; align-items: flex-end; justify-content: center;
    width: 100%; z-index: 1; padding-bottom: 8px;
  }
  .cta-shot img {
    max-width: 92%; max-height: 780px;
    border-radius: 12px;
    box-shadow: 0 20px 50px rgba(15, 23, 42, 0.12);
    border: 1px solid #e2e8f0;
  }
  .feats {
    display: flex; gap: 16px; width: 100%; margin-top: 28px; z-index: 1;
  }
  .feat {
    flex: 1; display: flex; gap: 10px; align-items: flex-start;
    background: rgba(255,255,255,0.72);
    border: 1px solid rgba(42,111,106,0.12);
    border-radius: 12px; padding: 14px 12px;
  }
  .feat-icon {
    width: 36px; height: 36px; border-radius: 10px;
    background: #e7f2f1; color: ${accent};
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
  }
  .feat-text strong { display: block; font-size: 15px; color: #1e293b; margin-bottom: 4px; }
  .feat-text span { font-size: 12px; color: #64748b; line-height: 1.4; }
  .footer {
    margin-top: 22px; font-size: 18px; color: ${accent};
    font-weight: 600; letter-spacing: 0.04em; z-index: 1;
  }
</style></head><body>
  ${titleBlock}
  ${shotBlock}
  ${features ? `<div class="feats">${features}</div>` : ""}
  ${card.footer ? `<div class="footer">${card.footer}</div>` : ""}
</body></html>`;
}

function logoB64() {
  const p = path.join(__dirname, "../../apps/web/public/logo-wordmark.png");
  return fs.readFileSync(p).toString("base64");
}

async function captureApp(page, card) {
  const url = `${BASE}${card.route}`;
  console.log(`  → ${url}`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
  if (card.afterNavigate) {
    await card.afterNavigate(page);
  }
  const selector = card.shotSelector || "[class*='shell']";
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 15000 });
  return loc.screenshot({ type: "png" });
}

async function renderCard(browser, card, screenshotBuf) {
  const b64 = screenshotBuf.toString("base64");
  const html = buildHtml(card, b64);
  const p = await browser.newPage();
  await p.setViewportSize({ width: 1024, height: 1536 });
  await p.setContent(html, { waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  const out = path.join(OUT_DIR, card.file);
  await p.screenshot({ path: out, type: "png" });
  await p.close();
  console.log(`  ✓ ${card.file}`);
}

async function main() {
  console.log(`空库 XHS 素材生成 · ${BASE}`);
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  try {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  } catch (err) {
    console.error(`无法打开 ${BASE}，请先运行 apps/desktop npm run dev`);
    console.error(err.message);
    process.exit(1);
  }

  for (const card of CARDS) {
    console.log(`\n[${card.file}]`);
    const shot = await captureApp(page, card);
    await renderCard(browser, card, shot);
  }

  await browser.close();
  console.log("\n全部完成 → branding/xhs/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
