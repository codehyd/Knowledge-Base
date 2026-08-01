#!/usr/bin/env bash
# 通过本机代理拉取 GitHub（Clash / 系统代理），解决 git pull 很慢或超时。
#
# 用法（仓库根目录）：
#   bash scripts/git-pull.sh
#   bash scripts/git-pull.sh --no-proxy          # 不走代理
#   GIT_PROXY=http://127.0.0.1:7897 bash scripts/git-pull.sh
#   bash scripts/git-pull.sh origin main
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USE_PROXY=1
REMOTE="origin"
BRANCH=""

usage() {
  sed -n '2,9p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --no-proxy)
      USE_PROXY=0
      shift
      ;;
    *)
      if [[ -z "$REMOTE" || "$REMOTE" == "origin" && "$1" != "origin" && -z "$BRANCH" ]]; then
        if [[ "$1" == "origin" || "$1" == "upstream" ]]; then
          REMOTE="$1"
        elif [[ -z "$BRANCH" ]]; then
          BRANCH="$1"
        fi
      elif [[ -z "$BRANCH" ]]; then
        BRANCH="$1"
      else
        echo "未知参数：$1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$BRANCH" ]]; then
    echo "当前不在分支上，请指定分支名" >&2
    exit 1
  fi
fi

try_proxy() {
  local proxy="$1"
  curl -sI --connect-timeout 3 -x "$proxy" https://github.com >/dev/null 2>&1
}

detect_proxy() {
  if [[ -n "${GIT_PROXY:-}" ]]; then
    echo "$GIT_PROXY"
    return 0
  fi
  if [[ -n "${https_proxy:-}" ]]; then
    echo "$https_proxy"
    return 0
  fi
  if [[ -n "${HTTPS_PROXY:-}" ]]; then
    echo "$HTTPS_PROXY"
    return 0
  fi
  local port
  for port in 7897 7890 7892 1087 6152; do
    local p="http://127.0.0.1:${port}"
    if try_proxy "$p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

PROXY=""
if [[ "$USE_PROXY" -eq 1 ]]; then
  if PROXY="$(detect_proxy)"; then
    echo "==> 使用代理：$PROXY"
  else
    echo "==> 未检测到可用代理，将直连（可能较慢）"
    echo "    可设置：GIT_PROXY=http://127.0.0.1:7897 bash scripts/git-pull.sh"
  fi
else
  echo "==> 已禁用代理（--no-proxy）"
fi

GIT_ARGS=()
if [[ -n "$PROXY" ]]; then
  GIT_ARGS+=(-c "http.proxy=$PROXY" -c "https.proxy=$PROXY")
fi

echo "==> 仓库：$ROOT"
echo "==> 拉取：$REMOTE $BRANCH"
git status -sb

echo "==> git fetch …"
git "${GIT_ARGS[@]}" fetch "$REMOTE" "$BRANCH"

echo "==> git pull --ff-only …"
git "${GIT_ARGS[@]}" pull --ff-only "$REMOTE" "$BRANCH"

echo
git status -sb
echo "最新提交：$(git log -1 --oneline)"
echo "拉取完成。"
