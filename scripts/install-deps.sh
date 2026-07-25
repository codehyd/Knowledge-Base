#!/usr/bin/env bash
# 拉取代码后一键安装/更新依赖（前端 + Python API）
# 用法（在仓库根目录）：
#   bash scripts/install-deps.sh
#   bash scripts/install-deps.sh --fresh-venv   # 重建 Python 虚拟环境
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FRESH_VENV=0
for arg in "$@"; do
  case "$arg" in
    --fresh-venv) FRESH_VENV=1 ;;
    -h|--help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用 --fresh-venv）" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f apps/api/requirements.txt ]]; then
  echo "请在仓库根目录执行本脚本" >&2
  exit 1
fi

echo "==> 空库 · 安装依赖（${ROOT}）"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "已创建 .env（可按需填入 LLM_API_KEY）"
fi

mkdir -p data/uploads data/exports data/tmp

pick_python() {
  local candidates=()
  if command -v python3.12 >/dev/null 2>&1; then candidates+=("python3.12"); fi
  if [[ -x "$HOME/.local/bin/python3.12" ]]; then candidates+=("$HOME/.local/bin/python3.12"); fi
  if command -v python3 >/dev/null 2>&1; then candidates+=("python3"); fi

  for py in "${candidates[@]}"; do
    local major minor
    major="$("$py" -c 'import sys; print(sys.version_info.major)' 2>/dev/null || echo 0)"
    minor="$("$py" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)"
    if [[ "$major" -eq 3 && "$minor" -ge 12 && "$minor" -le 13 ]]; then
      echo "$py"
      return 0
    fi
  done

  if command -v uv >/dev/null 2>&1; then
    echo "未找到 Python 3.12，尝试用 uv 安装…" >&2
    uv python install 3.12
    echo "$HOME/.local/bin/python3.12"
    return 0
  fi

  echo "需要 Python 3.12（或 3.13）。可安装：brew install python@3.12 或 curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  return 1
}

PY="$(pick_python)"
echo "==> Python：$("$PY" --version)"

VENV="apps/api/.venv"
if [[ "$FRESH_VENV" -eq 1 && -d "$VENV" ]]; then
  echo "==> 重建虚拟环境"
  rm -rf "$VENV"
fi

if [[ ! -d "$VENV" ]]; then
  echo "==> 创建 API 虚拟环境"
  "$PY" -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -U pip
pip install -r apps/api/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

install_node_deps() {
  local dir="$1"
  local name="$2"
  echo "==> 安装 ${name} 依赖：${dir}"
  (
    cd "$dir"
    if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
      pnpm install
      if [[ "$dir" == *desktop* ]]; then
        ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
          node node_modules/electron/install.js 2>/dev/null || true
      fi
    elif [[ -f package-lock.json ]]; then
      npm install --registry https://registry.npmmirror.com
    else
      npm install --registry https://registry.npmmirror.com
    fi
  )
}

install_node_deps apps/web "Web"
install_node_deps apps/desktop "Desktop"

if [[ "${INSTALL_SKIP_ASR_PREFETCH:-0}" != "1" ]]; then
  echo "==> 预下载 Whisper 语音模型（base，约 150MB；跳过：INSTALL_SKIP_ASR_PREFETCH=1）"
  set +e
  HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" \
    HF_HUB_DISABLE_XET=1 \
    HF_HUB_DOWNLOAD_TIMEOUT=600 \
    DATA_DIR="$ROOT/data" \
    python "$ROOT/apps/api/scripts/prefetch_whisper.py"
  prefetch_rc=$?
  set -e
  if [[ $prefetch_rc -ne 0 ]]; then
    echo "警告：Whisper 模型预下载失败（不影响其它功能）。可稍后重试，或在设置里改用云端转写。" >&2
  fi
fi

echo ""
echo "依赖安装完成。"
echo ""
echo "下一步："
echo "  cd apps/desktop && npm run dev     # Electron 开发（推荐）"
echo "  或 cd apps/web && npm run dev      # 仅网页"
echo ""
echo "若 API 仍报错，查看：data/api-dev.log"
