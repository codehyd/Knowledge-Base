# 功能点 12：桌面端 Electron（从零到一）

> 本篇回答：**一个"前端 + Python 后端"的 Web 应用，怎样打包成双击就能用的桌面软件——还要自动更新、对付抖音风控？**

---

## 1. 这个功能解决什么问题？

让用户自己装 Python、建 venv、起 uvicorn，99% 的人会放弃。桌面端要解决：

1. **一条命令/一个图标启动三个进程**：前端（Vite/静态页）、后端（Python API）、桌面壳（Electron）；
2. **用户机器上没有 Python**——后端要打成免环境的可执行文件（sidecar）；
3. **端口被占用/旧进程残留**——启动时要能识别并处理；
4. **抖音风控**——yt-dlp 抓不动时，用桌面端已登录的浏览器会话兜底；
5. **自动更新**——用户不手动下载新版。

## 2. 先修概念

- **主进程 / 渲染进程 / preload**：Electron 的三层——主进程管窗口和系统能力，渲染进程跑页面（无系统权限），preload 是两进程间的安全桥。
- **sidecar（边车）**：随主程序分发的独立可执行文件。本项目用 PyInstaller 把 FastAPI 打成 `kongku-api`。
- **partition 会话**：Electron 里隔离/持久化 Cookie 的机制，`persist:kongku-media` 让登录态跨启动保留。

## 3. 从零推导

### 第一步：启动编排——精算的并行与对称的清理

```js
// apps/desktop/electron/main.cjs:32-63（节选）
app.whenReady().then(async () => {
  await clearUiCacheIfVersionChanged();   // 防旧前端缓存配新后端
  registerIpcHandlers();
  startDouyinBridge();

  // API 与窗口并行：开发态先出 Vite UI，不再卡在「等后端」启动页上
  const apiPromise = startApiSynced().catch(...);
  await createWindow({ deferDevLoad: false });

  if (app.isPackaged) {
    await apiPromise;        // 打包态静态页由 API 托管，必须等 API
    await loadAppUi();
  } else {
    void apiPromise.then(...); // 开发态 UI 来自 Vite，AppLayout 自行探测 API
  }
  setupAutoUpdater();
```

**设计解读**：
- **先清版本缓存**：Electron 会强缓存 localhost 前端，升级后可能"新后端配旧界面"出灵异 bug；
- **开发态与打包态分叉**：开发态前端来自 Vite（不依赖后端，先出 UI）；打包态静态页由 API 进程托管（`KONGKU_WEB_DIR`），必须等 API 就绪——这就是功能点 01 里"API 同源托管前端"存在的意义；
- **退出清理对称**：`stopApi()` 只杀"自己拉起的"进程——用户手动起的 API 不动。

### 第二步：拉起 Python——开发态 vs 打包态

```js
// electron/lib/api-process.cjs（节选）
// 开发态：仓库 .venv 的 uvicorn，改代码即生效
const uvicorn = path.join(root, "apps", "api", ".venv", "Scripts", "uvicorn.exe"); // win
// 打包态：PyInstaller sidecar
spawnApiProcess(sidecar, [], { env, cwd: appDataRoot() });
```

两条路径都汇入 `waitForHealth(90000)` 轮询 `/health` 确认就绪——**"拉起"与"就绪"分离**。

环境注入（`buildApiEnv`）是 Electron→Python 的唯一配置通道：`KONGKU_API_PORT`、`DATA_DIR`、`KONGKU_YTDLP_COOKIES`、`KONGKU_DESKTOP_BRIDGE`、`DATABASE_URL=sqlite:///<userData>/data/kongku.db`（除非 `KONGKU_USE_ENV_DB=1`，防系统环境变量劫持）。配套的 `sanitizeSidecarEnv` 删掉 `PYTHONHOME/PYTHONPATH/ELECTRON_RUN_AS_NODE` 和代理变量——**每行都是踩坑记录**（如 Clash 代理会让抖音抓取 403，被 yt-dlp 误报成 Cookie 失效）。

### 第三步：端口治理——复用还是杀掉？

```js
// api-process.cjs:173-205（节选）
/**
 * 端口上已有 API 时，仅在「带笔记库/技能路由」时复用。
 * 升级后常见：旧 kongku-api 孤儿仍占 18765，新前端点笔记 → Not Found。
 */
async function canReuseExternalApi() {
  const health = await httpGetJson(`${API_ORIGIN}/health`, 600);  // 短超时快速失败
  const features = health.data?.features ?? [];
  if (features.includes("vault") && features.includes("skills")) return true;
  // 旧版无 features：轻量探 /api/skills 路由
  ...
}
```

**设计解读**：端口被占有两难——无脑复用可能连上旧版孤儿进程（新功能 404），粗暴杀光可能误杀用户自己的服务。解法是**能力协商**：看 `/health` 的 features 是否含 `vault`+`skills`，不合格才 `killStaleApiListeners`（Windows 用 `netstat -ano | findstr` 找 PID 再 `taskkill /F /T`）。探测超时故意很短（600ms），端口无人时快速失败不拖启动。

### 第四步：抖音桥——用真浏览器反风控

```js
// electron/lib/douyin-bridge.cjs:121-135（节选）
const ses = mediaSession();   // persist:kongku-media 复用登录态
const onCompleted = (details) => {
  const u = details.url || "";
  if (/\.(mp4|m4a|mp3)(\?|$)/i.test(u) ||
      /douyinvod|bytevod|snssdk\.com|amemv\.com|ixigua\.com/i.test(u)) {
    if ((details.statusCode || 0) >= 200 && (details.statusCode || 0) < 400) {
      candidates.push(u);
    }
  }
};
ses.webRequest.onCompleted({ urls: ["*://*/*"] }, onCompleted);
```

**为什么这样写**：yt-dlp 调抖音接口会被签名/风控挡掉，但桌面端有**用户真实登录的浏览器**。做法：开一个隐藏 BrowserWindow 打开视频页，`webRequest` 全网嗅探 `.mp4/.m4a` 及字节系 CDN 域名，再注入 JS 主动 `video.play()` 逼播放器发请求；候选按"m4a 音频 +50 分、字节 CDN +20 分"打分择优，下载后回传给 API（呼应功能点 05 的 `_download_via_desktop_bridge`）。

Cookie 导出（`media.cjs`）：`session.cookies.get({})` → 转成 yt-dlp 认的 **Netscape 格式**（7 列 tab 分隔，domain 归一化为 `.example.com` 前导点形式），优先只挑字节系域名（减少泄露面），写入 `data/yt-dlp-cookies.txt`。登录窗里 2 秒轮询检测 `sessionid` 等登录态 Cookie，**一登录就自动导出**——"登录→可用"闭环。

### 第五步：打包与自动更新

`package.json` build 段的关键决策：

```json
"extraResources": [
  { "from": "../web/dist", "to": "web" },     // 前端产物
  { "from": "resources/api", "to": "api" }    // PyInstaller sidecar
],
"publish": [{ "provider": "github", "owner": "codehyd", "repo": "Knowledge-Base" }],
"nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
```

- `extraResources` 把前端和 sidecar 塞进安装包，运行时经 `process.resourcesPath` 找到；
- NSIS 选**非一键安装**：含 sidecar 的应用装到中文/空格路径时一键安装更易踩坑，让用户自选目录；
- mac 打 dmg + zip 双 target——**zip 是给自动更新用的**（dmg 不支持增量替换）。

updater（`lib/updater.cjs`）：`autoDownload=false`（下载决定权给用户）；`disableDifferentialDownload=true`（GitHub 差量包在国内网络不稳）；下载失败按网络错误正则重试 3 次、指数退避，最终把 `ERR_CONNECTION_RESET` 翻译成人话并建议手动下载。发版走 `scripts/release-desktop.ps1`：版本自增 + 打 tag → GitHub Actions 跨平台构建 → Releases，与 updater 形成闭环。

### 第六步：一条命令的启动链

`scripts/dev.cjs` 的 `ensureVite()`：先 1.5 秒探测 41779——已有 Vite 直接复用（前端开发者可能单独开着），没有才 `npm run dev` 拉起并用 `spawnedViteByUs` 标记所有权，退出时只杀自己拉起的（Windows 杀进程树要 `taskkill /pid /f /t`）。Electron 经 `KONGKU_DEV_WEB` 拿到 Vite 地址——`npm run dev` 一条命令串起 Vite → Electron →（再拉 Python）三层启动链。

## 4. 完整流程图

```
npm run dev（apps/desktop）
   ├─ ensureVite：41779 有人？复用 : 拉起 npm run dev（标记所有权）
   ├─ 启动 Electron（KONGKU_DEV_WEB 告知前端地址）
   │    ├─ 清版本缓存 → 注册 IPC → 抖音桥 18766
   │    ├─ startApiSynced：canReuseExternalApi 能力协商 → 复用/杀旧/拉起
   │    │     开发态 .venv uvicorn ｜ 打包态 sidecar（sanitizeSidecarEnv + buildApiEnv）
   │    ├─ waitForHealth(/health) → 开发态 Vite UI / 打包态 API 托管静态页
   │    └─ 自动更新（GitHub Releases，网络错误友好化）
   └─ 退出：只杀自己拉起的进程树
```

## 5. 关键文件与配置对照

| 文件 | 职责 |
|------|------|
| `apps/desktop/electron/main.cjs` | 启动编排与退出清理 |
| `apps/desktop/electron/lib/api-process.cjs` | Python 拉起、环境注入、端口治理 |
| `apps/desktop/electron/lib/douyin-bridge.cjs` | 18766 抖音下载桥 |
| `apps/desktop/electron/lib/media.cjs` | 登录窗、Netscape Cookie 导出 |
| `apps/desktop/electron/lib/updater.cjs` | 自动更新 |
| `apps/desktop/scripts/dev.cjs` | 开发启动链 |
| `apps/api/scripts/build_sidecar.py` | PyInstaller 打包后端 |
| `.github/workflows/release-desktop.yml` | tag 触发跨平台 Release |

| 环境变量 | 说明 |
|----------|------|
| `KONGKU_FORCE_SIDECAR=1` | 禁用外部 API 复用（调试用） |
| `KONGKU_USE_ENV_DB=1` | 允许系统 DATABASE_URL 生效 |
| `KONGKU_KEEP_PROXY=1` | 不清理代理变量 |
| `KONGKU_DESKTOP_BRIDGE_PORT` | 抖音桥端口（默认 18766） |
