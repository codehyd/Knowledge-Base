# 空库 · 桌面端（Electron）

## 生命周期（当前）

| 动作 | 行为 |
|------|------|
| 打开 Electron | **自动拉起** Python API（开发：`.venv/uvicorn`；打包：`resources/api/kongku-api`） |
| 关闭 Electron | **结束自己拉起的** API 子进程；若启动前端口上已有外部 API，则不杀 |
| 数据库 | **不启停独立 DB 进程**；默认 SQLite（`data/kongku.db`） |
| 启动 | API 启动时 `init_db` 建表；个人版无需 Docker |

```mermaid
flowchart LR
  openApp[Open Electron] --> spawnApi[Spawn Python API]
  spawnApi --> sqlite[SQLite data/kongku.db]
  spawnApi --> health["/health"]
  health --> uiOk[Normal UI]
  closeApp[Close Electron] --> killApi[Kill spawned API]
```

日常网页调试：Vite + 手动 uvicorn（同样默认 SQLite），不必开 Electron。

## 目录

- `apps/desktop/electron/`：主进程 / preload  
- `apps/desktop/resources/api/`：API sidecar（`kongku-api` / `.exe`）  
- `apps/api/run_sidecar.py` + `scripts/build_sidecar.py`：打 sidecar  
- `.github/workflows/release-desktop.yml`：`v*` tag → win/mac/linux

## 本地试跑（验证启停同步）

1. 先停掉手动开的 API（确保 18765 空闲）  
2. 开 Electron（会按需拉起 Vite + API；默认 SQLite）：

```powershell
cd apps/desktop
npm install
# 默认连 http://127.0.0.1:41779；不需要再设 KONGKU_SPAWN_API
npm run dev
```

验收：开壳后 18765 有进程；关壳后 18765 应退出。

## 本地打 sidecar + 安装包

一键脚本（推荐）：

```bash
# Git Bash / macOS / Linux
bash scripts/pack-desktop.sh win
bash scripts/pack-desktop.sh mac
bash scripts/pack-desktop.sh linux
bash scripts/pack-desktop.sh win --skip-sidecar --skip-web   # 只重打 Electron
```

```powershell
# Windows PowerShell
.\scripts\pack-desktop.ps1 win
.\scripts\pack-desktop.ps1 win -SkipSidecar -SkipWeb
```

手动步骤：

```powershell
cd apps/api
.\.venv\Scripts\activate
pip install -r requirements.txt
python scripts/build_sidecar.py

cd ..\web
$env:ELECTRON="1"
npm run build

cd ..\desktop
npm install
npm run dist
```

产物在 `apps/desktop/release/`。本机一般只能打当前系统对应平台；三端齐全请推 `v*` tag 走 GitHub Actions。

## 应用图标

字标：`apps/web/public/logo-wordmark.png`  
应用方标（任务栏 / 安装包）：由脚本从字标左侧书本图形生成：

```powershell
python apps/desktop/scripts/generate-icons.py
```

产物：

- `apps/desktop/build/icon.png`（mac/linux + electron-builder）
- `apps/desktop/build/icon.ico`（Windows）
- `apps/desktop/electron/icon.png`（窗口备用）

## GitHub 发版

推荐用脚本（默认 **patch 自增**，并推送 `v*` tag 触发 Actions）：

```powershell
# Windows
.\scripts\release-desktop.ps1              # v0.1.0 -> v0.1.1
.\scripts\release-desktop.ps1 -Bump minor  # -> v0.2.0
.\scripts\release-desktop.ps1 0.3.0        # 指定版本
.\scripts\release-desktop.ps1 -DryRun      # 只预览
```

```bash
# Git Bash / macOS / Linux
./scripts/release-desktop.sh
./scripts/release-desktop.sh --minor
./scripts/release-desktop.sh 0.3.0
```

手工方式：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Actions「Release Desktop」会：装 Python 依赖 → PyInstaller sidecar → 打 Electron → 上传 Release。

### macOS 签名

未配置 Apple 证书时 `CSC_IDENTITY_AUTO_DISCOVERY=false`，仍可出包；用户可能需「右键 → 打开」。

## electron-updater

主进程已 `checkForUpdates`；前端可通过 `window.kongkuDesktop` 监听更新。
