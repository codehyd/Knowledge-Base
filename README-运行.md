# 空库 · 运行说明（个人版 · 默认无 Docker）

个人使用默认 **SQLite**（`data/kongku.db`），不依赖 Docker / Postgres。

## 日常开发：网页 vs Electron（推荐）

| 场景 | 怎么启动 | Vite | Python API | 数据库 |
|------|----------|------|------------|--------|
| **Electron（常用）** | `cd apps/desktop && npm run dev` | 自动拉起 | Electron 自动拉起；关壳停自己起的 | 默认 SQLite |
| **网页端调试** | `cd apps/web && npm run dev` → http://127.0.0.1:41779 | 手动开 | 需另开 uvicorn（见下） | 默认 SQLite |

```powershell
# Electron 一键（推荐）
cd apps\desktop
npm run dev
```

网页调试时另开 API：

```powershell
cd apps\api
.\.venv\Scripts\activate
pip install -r requirements.txt
# 不设 DATABASE_URL → 使用 data/kongku.db
uvicorn app.main:app --reload --host 127.0.0.1 --port 18765
```

- 网页：http://127.0.0.1:41779  
- API 文档（Knife4j）：http://127.0.0.1:18765/doc.html  

首次可复制环境文件（Key 等）：

```powershell
copy .env.example .env
```

## 端口一览

| 服务 | 端口 |
|------|------|
| API | 18765 |
| Vite 前端 | 41779 |

数据文件：仓库下 `data/kongku.db`（以及 `data/uploads` 等）。

## 桌面端发版

见 [docs/工程/13-桌面端Electron.md](./docs/工程/13-桌面端Electron.md)。

```powershell
.\scripts\release-desktop.ps1
```

## 可选：自备 Postgres

个人版不强制。若你自己有云库 / 本机 Postgres，可在 **设置 → 数据库** 切换（须能连通）。  
历史 Docker Compose 文件已挪到 `archive/docker/`，默认流程不再使用。

## 架构约定

见 [docs/工程/02-架构约定.md](./docs/工程/02-架构约定.md)。

## 常见问题

| 现象 | 处理 |
|------|------|
| Electron 白屏 | 等 Vite 起来；或看终端是否在拉 `apps/web` |
| API 起不来 / 缺 aiosqlite | `cd apps/api && .venv\Scripts\pip install -r requirements.txt` |
| 41779/18765 被占用 | 改端口或先关掉占用进程 |
| 文档打不开 | 访问 **/doc.html**（不是旧版 `/docs`） |
| Key 测试失败 | DeepSeek Base URL 一般为 `https://api.deepseek.com/v1` |
| 想用以前 Docker 里的数据 | 需自行从旧库导出/迁移到 SQLite；两套库不自动同步 |
