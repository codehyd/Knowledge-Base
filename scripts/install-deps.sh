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

# 本项目依赖（如 pyinstaller==6.12.0）尚未适配 3.14+，锁定 3.12–3.13
python_version_ok() {
  local py="$1"
  local major minor
  major="$("$py" -c 'import sys; print(sys.version_info.major)' 2>/dev/null || echo 0)"
  minor="$("$py" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)"
  [[ "$major" -eq 3 && "$minor" -ge 12 && "$minor" -le 13 ]]
}

to_bash_path() {
  local p="$1"
  [[ -n "$p" ]] || return 0
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$p" 2>/dev/null || echo "$p"
  else
    echo "$p" | sed -E 's#^([A-Za-z]):[\\/]#/\L\1/#; s#\\#/#g'
  fi
}

# 把可用解释器按「3.13 > 3.12，跳过 3.14+」写入 candidates
collect_python_candidates() {
  candidates=()
  local seen="|"
  local name py win_local win_roaming line ver exe is_default
  local -a ranked=()

  add_candidate() {
    local py="$1"
    [[ -n "$py" ]] || return 0
    # Git Bash 下 Windows 路径可能无 -x，改用 -f
    [[ -x "$py" || -f "$py" ]] || return 0
    case "$seen" in
      *"|$py|"*) return 0 ;;
    esac
    # 跳过已失效的解释器（文件在但跑不起来）
    if ! "$py" -c "import sys" >/dev/null 2>&1; then
      return 0
    fi
    seen="${seen}|$py|"
    candidates+=("$py")
  }

  # 1) 读本机 py 启动器清单（只收 3.12 / 3.13）
  if command -v py >/dev/null 2>&1; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line//$'\r'/}"
      [[ -n "$line" ]] || continue
      is_default=0
      exe=""
      ver=""
      if [[ "$line" =~ -V:([^[:space:]]+)[[:space:]]+\*[[:space:]]+(.+\.[Ee][Xx][Ee]) ]]; then
        ver="${BASH_REMATCH[1]}"
        exe="$(to_bash_path "${BASH_REMATCH[2]}")"
        is_default=1
      elif [[ "$line" =~ -V:([^[:space:]]+)[[:space:]]+(.+\.[Ee][Xx][Ee]) ]]; then
        ver="${BASH_REMATCH[1]}"
        exe="$(to_bash_path "${BASH_REMATCH[2]}")"
      else
        continue
      fi
      if [[ "$ver" =~ (3\.[0-9]+) ]]; then
        ver="${BASH_REMATCH[1]}"
      else
        continue
      fi
      major="${ver%%.*}"
      minor="${ver#*.}"
      [[ "$major" == "3" && "$minor" -ge 12 && "$minor" -le 13 ]] || continue
      # 同版本内：默认标记略优先；跨版本：3.13 > 3.12
      if [[ "$is_default" -eq 1 ]]; then
        ranked+=("$((400 + minor)):$exe")
      else
        ranked+=("$((300 + minor)):$exe")
      fi
    done < <(py -0p 2>/dev/null || true)

    if ((${#ranked[@]})); then
      while IFS= read -r line; do
        py="${line#*:}"
        add_candidate "$py"
      done < <(printf '%s\n' "${ranked[@]}" | sort -t: -k1,1nr)
    fi
  fi

  # 2) uv 已下载的 3.12/3.13（Windows 上很常见，不必再装一份官方包）
  win_roaming="${APPDATA:-}"
  if [[ -n "$win_roaming" ]]; then
    win_roaming="$(to_bash_path "$win_roaming")"
    if [[ -d "$win_roaming/uv/python" ]]; then
      while IFS= read -r py; do
        add_candidate "$py"
      done < <(find "$win_roaming/uv/python" -name 'python.exe' 2>/dev/null | sort -V -r | head -n 12 || true)
    fi
  fi
  if command -v uv >/dev/null 2>&1; then
    for name in 3.13 3.12; do
      py="$(uv python find "$name" 2>/dev/null || true)"
      [[ -n "$py" ]] || continue
      add_candidate "$(to_bash_path "$py")"
    done
  fi

  # 3) PATH 里的 python（优先 3.13 / 3.12）
  for name in python3.13 python3.12 python3 python; do
    if command -v "$name" >/dev/null 2>&1; then
      add_candidate "$(command -v "$name")"
    fi
  done

  if command -v which >/dev/null 2>&1; then
    while IFS= read -r py; do
      add_candidate "$py"
    done < <(which -a python3.13 python3.12 python3 python 2>/dev/null || true)
  fi

  # 4) 扫描本机常见安装目录
  win_local="${LOCALAPPDATA:-}"
  if [[ -n "$win_local" ]]; then
    win_local="$(to_bash_path "$win_local")"
    if [[ -d "$win_local/Programs/Python" ]]; then
      while IFS= read -r py; do
        add_candidate "$py"
      done < <(ls -1d "$win_local"/Programs/Python/Python31[23]/python.exe 2>/dev/null | sort -V -r || true)
    fi
  fi

  for py in \
    "$HOME/.local/bin/python3.13" \
    "$HOME/.local/bin/python3.12" \
    "/opt/homebrew/bin/python3.13" \
    "/opt/homebrew/bin/python3.12" \
    "/usr/local/bin/python3.13" \
    "/usr/local/bin/python3.12" \
    "/c/Python313/python.exe" \
    "/c/Python312/python.exe"; do
    add_candidate "$py"
  done
}

pick_python() {
  local py uv_py

  collect_python_candidates
  for py in "${candidates[@]+"${candidates[@]}"}"; do
    if python_version_ok "$py"; then
      echo "$py"
      return 0
    fi
  done

  if command -v uv >/dev/null 2>&1; then
    for uv_py in $(uv python find 3.13 2>/dev/null) $(uv python find 3.12 2>/dev/null); do
      uv_py="$(to_bash_path "$uv_py")"
      if [[ -n "$uv_py" && ( -x "$uv_py" || -f "$uv_py" ) ]] && python_version_ok "$uv_py"; then
        echo "$uv_py"
        return 0
      fi
    done

    echo "未找到 Python 3.12/3.13，尝试用 uv 安装 3.12（无需再装官方安装包）…" >&2
    uv python install 3.12
    uv_py="$(uv python find 3.12 2>/dev/null || echo "$HOME/.local/bin/python3.12")"
    echo "$(to_bash_path "$uv_py")"
    return 0
  fi

  echo "需要 Python 3.12 或 3.13（当前依赖尚未适配 3.14+）。" >&2
  echo "  你本机若只有 3.14：不必再装官方包，可先装 uv 后自动拉 3.12：" >&2
  echo "    curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "    uv python install 3.12" >&2
  echo "  或 Windows：.\\\\scripts\\\\install-deps.ps1" >&2
  echo "  macOS：brew install python@3.12" >&2
  return 1
}

venv_is_usable() {
  local venv="$1"
  local py=""
  if [[ -f "$venv/Scripts/python.exe" ]]; then
    py="$venv/Scripts/python.exe"
  elif [[ -f "$venv/bin/python" ]]; then
    py="$venv/bin/python"
  else
    return 1
  fi
  # 能跑且版本在 3.12–3.13；若是刚建的 3.14 venv 也会判定为不可用并重建
  "$py" -c "import sys" >/dev/null 2>&1 && python_version_ok "$py"
}

PY="$(pick_python)"
echo "==> Python：$("$PY" --version)  ($PY)"

VENV="apps/api/.venv"
if [[ "$FRESH_VENV" -eq 1 && -d "$VENV" ]]; then
  echo "==> 重建虚拟环境（--fresh-venv）"
  rm -rf "$VENV"
elif [[ -d "$VENV" ]] && ! venv_is_usable "$VENV"; then
  echo "==> 现有虚拟环境不可用或版本不符（需要 3.12–3.13），自动重建"
  rm -rf "$VENV"
fi

if [[ ! -d "$VENV" ]]; then
  echo "==> 创建 API 虚拟环境"
  "$PY" -m venv "$VENV"
fi

# Windows venv 在 Scripts/，Unix 在 bin/
if [[ -f "$VENV/Scripts/activate" ]]; then
  # shellcheck disable=SC1091
  source "$VENV/Scripts/activate"
elif [[ -f "$VENV/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
else
  echo "虚拟环境激活脚本不存在：$VENV" >&2
  exit 1
fi
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
