#!/usr/bin/env bash
# 桌面端发版：打 v* tag 并推送，触发 GitHub Actions「Release Desktop」
#
# 用法（在仓库根目录）：
#   bash scripts/release-desktop.sh              # 默认 patch 自增
#   bash scripts/release-desktop.sh --minor
#   bash scripts/release-desktop.sh --major
#   bash scripts/release-desktop.sh 0.3.0
#   bash scripts/release-desktop.sh --dry-run
#   bash scripts/release-desktop.sh --skip-fetch # 网络不通时跳过拉 tag
set -euo pipefail

# 无论从哪启动，都切到仓库根（脚本必须在 scripts/ 下）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f apps/desktop/package.json ]]; then
  echo "未找到 apps/desktop/package.json。请在仓库根执行：bash scripts/release-desktop.sh" >&2
  exit 1
fi

BUMP="patch"
VERSION=""
DRY_RUN=0
FORCE=0
SKIP_FETCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch) BUMP="patch"; shift ;;
    --minor) BUMP="minor"; shift ;;
    --major) BUMP="major"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-fetch) SKIP_FETCH=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      VERSION="${1#v}"
      VERSION="${VERSION%%-*}"  # 允许传入 0.1.1-test，取数字部分
      shift
      ;;
  esac
done

if [[ "$SKIP_FETCH" -ne 1 ]]; then
  echo "==> 同步远程标签（约 20s 超时；网络不通可加 --skip-fetch）"
  set +e
  GIT_HTTP_LOW_SPEED_LIMIT=1000 \
  GIT_HTTP_LOW_SPEED_TIME=20 \
  git fetch origin --tags --prune
  fetch_rc=$?
  set -e
  if [[ $fetch_rc -ne 0 ]]; then
    echo "警告：fetch tags 失败，将按本地 tag / package.json 计算版本" >&2
    echo "      也可重试：bash scripts/release-desktop.sh --skip-fetch" >&2
  else
    echo "远程标签已同步"
  fi
else
  echo "==> 已跳过 fetch tags（--skip-fetch）"
fi

# 取最新 vX.Y.Z 或 vX.Y.Z-xxx（如 v0.1.1-test）
latest_tag() {
  git tag -l 'v*' --sort=-v:refname | head -n1 || true
}

# 不依赖 python（Windows 商店 python 常为占位符会卡住）
pkg_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' apps/desktop/package.json | head -n1
}

bump_semver() {
  local ver="$1" kind="$2"
  IFS=. read -r maj min pat <<<"$ver"
  case "$kind" in
    major) maj=$((maj + 1)); min=0; pat=0 ;;
    minor) min=$((min + 1)); pat=0 ;;
    *) pat=$((pat + 1)) ;;
  esac
  echo "${maj}.${min}.${pat}"
}

if [[ -n "$VERSION" ]]; then
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "版本号格式应为 x.y.z" >&2
    exit 1
  fi
  NEXT="$VERSION"
else
  BASE_TAG="$(latest_tag)"
  # 兼容 v0.1.1 与 v0.1.1-test
  if [[ -n "$BASE_TAG" && "$BASE_TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)([.-].*)?$ ]]; then
    BASE="${BASH_REMATCH[1]}"
  else
    BASE="$(pkg_version)"
    BASE="${BASE%%-*}"
    BASE_TAG="v${BASE}"
  fi
  if [[ ! "$BASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "无法解析基础版本（tag=${BASE_TAG:-无}）。请指定版本：bash scripts/release-desktop.sh 0.1.2" >&2
    exit 1
  fi
  NEXT="$(bump_semver "$BASE" "$BUMP")"
  echo "基于 ${BASE_TAG} 按 --${BUMP} 自增 -> v${NEXT}"
fi

TAG="v${NEXT}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "标签已存在：${TAG}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" && "$FORCE" -ne 1 ]]; then
  echo "工作区有未提交改动，请先提交；或加 --force" >&2
  git status -sb
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] 将发布 ${TAG}"
  echo "  更新 apps/desktop/package.json version=${NEXT}"
  echo "  git tag ${TAG} && git push origin HEAD && git push origin ${TAG}"
  exit 0
fi

# 仅替换首个 version 字段
tmp="$(mktemp)"
awk -v ver="$NEXT" '
  BEGIN { done=0 }
  {
    if (!done && $0 ~ /"version"[[:space:]]*:/) {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]+"/, "\"version\": \"" ver "\"")
      done=1
    }
    print
  }
' apps/desktop/package.json >"$tmp"
mv "$tmp" apps/desktop/package.json
echo "更新 package.json -> ${NEXT}"

git add apps/desktop/package.json
if ! git diff --cached --quiet; then
  git commit -m "chore(desktop): release ${TAG}"
fi

git tag -a "${TAG}" -m "Release ${TAG}"
echo "==> 推送分支与标签（若卡住，多半是网络访问 GitHub 问题）"
git push origin HEAD
git push origin "${TAG}"

echo
echo "已推送 ${TAG}，Actions: https://github.com/codehyd/Knowledge-Base/actions"
echo "产物: https://github.com/codehyd/Knowledge-Base/releases"
