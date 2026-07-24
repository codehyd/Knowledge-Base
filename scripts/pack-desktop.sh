#!/usr/bin/env bash
# 本地打包桌面端（不推送 GitHub；默认 --publish never）
#
# 用法（仓库根目录）：
#   bash scripts/pack-desktop.sh win
#   bash scripts/pack-desktop.sh mac
#   bash scripts/pack-desktop.sh linux
#   bash scripts/pack-desktop.sh all
#   bash scripts/pack-desktop.sh win --skip-sidecar   # 已打过 sidecar 时跳过
#   bash scripts/pack-desktop.sh win --skip-web       # 已打过前端时跳过
#   bash scripts/pack-desktop.sh win --dir            # 只打未打包目录（更快试跑）
#
# 产物：apps/desktop/release/
#
# 注意：本机一般只能打「当前系统」对应平台；跨平台请用 GitHub Actions。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f apps/desktop/package.json ]]; then
  echo "未找到 apps/desktop/package.json。请在仓库根执行：bash scripts/pack-desktop.sh win" >&2
  exit 1
fi

TARGET=""
SKIP_SIDECAR=0
SKIP_WEB=0
DIR_ONLY=0
PUBLISH="never"

usage() {
  sed -n '2,16p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    win|windows|mac|macos|darwin|linux|all)
      TARGET="$1"
      shift
      ;;
    --skip-sidecar) SKIP_SIDECAR=1; shift ;;
    --skip-web) SKIP_WEB=1; shift ;;
    --dir) DIR_ONLY=1; shift ;;
    --publish)
      PUBLISH="${2:-never}"
      shift 2
      ;;
    --publish=*)
      PUBLISH="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "请指定打包类型：win | mac | linux | all" >&2
  usage >&2
  exit 1
fi

case "$TARGET" in
  windows) TARGET="win" ;;
  macos|darwin) TARGET="mac" ;;
esac

detect_host() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo "win" ;;
    Darwin) echo "mac" ;;
    Linux) echo "linux" ;;
    *)
      # Git Bash / 部分环境 uname 异常时用 OSTYPE
      case "${OSTYPE:-}" in
        msys*|cygwin*|win*) echo "win" ;;
        darwin*) echo "mac" ;;
        linux*) echo "linux" ;;
        *) echo "unknown" ;;
      esac
      ;;
  esac
}

HOST="$(detect_host)"

resolve_electron_args() {
  local t="$1"
  local extra=()
  if [[ "$DIR_ONLY" -eq 1 ]]; then
    extra+=(--dir)
  fi
  case "$t" in
    win) echo "--win --x64 ${extra[*]-}" ;;
    mac) echo "--mac --x64 --arm64 ${extra[*]-}" ;;
    linux) echo "--linux --x64 ${extra[*]-}" ;;
  esac
}

warn_cross_compile() {
  local t="$1"
  if [[ "$HOST" == "unknown" ]]; then
    return
  fi
  if [[ "$t" != "all" && "$t" != "$HOST" ]]; then
    echo "警告：当前系统是 ${HOST}，正在打 ${t} 包；跨平台可能失败或产物不可用。" >&2
    echo "      完整三端请用：bash scripts/release-desktop.sh（推 tag → GitHub Actions）" >&2
  fi
  if [[ "$t" == "all" ]]; then
    echo "警告：all 会在本机连续打三端，非当前系统的目标通常会失败。" >&2
  fi
}

api_python() {
  if [[ -x "$ROOT/apps/api/.venv/Scripts/python.exe" ]]; then
    echo "$ROOT/apps/api/.venv/Scripts/python.exe"
  elif [[ -x "$ROOT/apps/api/.venv/bin/python" ]]; then
    echo "$ROOT/apps/api/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    command -v python3
  elif command -v python >/dev/null 2>&1; then
    command -v python
  else
    echo ""
  fi
}

build_sidecar() {
  echo "==> 1/3 构建 API sidecar"
  local py
  py="$(api_python)"
  if [[ -z "$py" ]]; then
    echo "未找到 Python。请先创建 apps/api/.venv 并安装依赖。" >&2
    exit 1
  fi
  "$py" -m pip install -q -r "$ROOT/apps/api/requirements.txt" pyinstaller
  (
    cd "$ROOT/apps/api"
    "$py" scripts/build_sidecar.py
  )
  if [[ -f "$ROOT/apps/desktop/resources/api/kongku-api.exe" ]]; then
    echo "sidecar ok: apps/desktop/resources/api/kongku-api.exe"
  elif [[ -f "$ROOT/apps/desktop/resources/api/kongku-api" ]]; then
    echo "sidecar ok: apps/desktop/resources/api/kongku-api"
  else
    echo "sidecar 未生成：apps/desktop/resources/api/" >&2
    exit 1
  fi
}

build_web() {
  echo "==> 2/3 构建前端 (ELECTRON=1)"
  if [[ ! -d "$ROOT/apps/web/node_modules" ]]; then
    (cd "$ROOT/apps/web" && npm ci)
  fi
  (cd "$ROOT/apps/web" && ELECTRON=1 npm run build)
  if [[ ! -f "$ROOT/apps/web/dist/index.html" ]]; then
    echo "前端构建失败：缺少 apps/web/dist/index.html" >&2
    exit 1
  fi
  echo "web ok: apps/web/dist"
}

build_electron() {
  local t="$1"
  local args
  args="$(resolve_electron_args "$t")"
  # shellcheck disable=SC2086
  echo "==> 3/3 electron-builder ${t}: ${args} --publish ${PUBLISH}"
  if [[ ! -d "$ROOT/apps/desktop/node_modules" ]]; then
    (cd "$ROOT/apps/desktop" && npm install)
  fi
  (
    cd "$ROOT/apps/desktop"
    export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"
    # shellcheck disable=SC2086
    npx electron-builder ${args} --publish "${PUBLISH}"
  )
}

pack_one() {
  local t="$1"
  warn_cross_compile "$t"
  build_electron "$t"
}

warn_cross_compile "$TARGET"

if [[ "$SKIP_SIDECAR" -eq 0 ]]; then
  build_sidecar
else
  echo "==> 跳过 sidecar（--skip-sidecar）"
fi

if [[ "$SKIP_WEB" -eq 0 ]]; then
  build_web
else
  echo "==> 跳过前端（--skip-web）"
fi

case "$TARGET" in
  all)
    for t in win mac linux; do
      echo
      echo "======== 打包 ${t} ========"
      if ! pack_one "$t"; then
        echo "警告：${t} 打包失败，继续下一个" >&2
      fi
    done
    ;;
  win|mac|linux)
    pack_one "$TARGET"
    ;;
  *)
    echo "不支持的类型：$TARGET" >&2
    exit 1
    ;;
esac

echo
echo "完成。产物目录：${ROOT}/apps/desktop/release"
ls -lh "$ROOT/apps/desktop/release" 2>/dev/null || ls "$ROOT/apps/desktop/release"
