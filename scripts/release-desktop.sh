#!/usr/bin/env bash
# 桌面端发版：打 v* tag 并推送，触发 GitHub Actions「Release Desktop」
#
# 用法：
#   ./scripts/release-desktop.sh              # 默认 patch 自增
#   ./scripts/release-desktop.sh --minor
#   ./scripts/release-desktop.sh --major
#   ./scripts/release-desktop.sh 0.3.0
#   ./scripts/release-desktop.sh --dry-run
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 同步远程标签（避免换机器时本地 tag 不全）"
if ! git fetch origin --tags --prune; then
  echo "警告：fetch tags 失败，将仅根据本地 tag / package.json 计算版本" >&2
fi

BUMP="patch"
VERSION=""
DRY_RUN=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch) BUMP="patch"; shift ;;
    --minor) BUMP="minor"; shift ;;
    --major) BUMP="major"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      VERSION="${1#v}"
      shift
      ;;
  esac
done

latest_tag() {
  git tag -l 'v*' --sort=-v:refname | head -n1 || true
}

pkg_version() {
  python - <<'PY'
import json
from pathlib import Path
print(json.load(open("apps/desktop/package.json", encoding="utf-8"))["version"])
PY
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
  if [[ -n "$BASE_TAG" && "$BASE_TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    BASE="${BASH_REMATCH[1]}"
  else
    BASE="$(pkg_version)"
    BASE_TAG="v${BASE}"
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

python - <<PY
import json
from pathlib import Path
p = Path("apps/desktop/package.json")
data = json.loads(p.read_text(encoding="utf-8"))
data["version"] = "${NEXT}"
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"更新 package.json -> ${NEXT}")
PY

git add apps/desktop/package.json
if ! git diff --cached --quiet; then
  git commit -m "chore(desktop): release ${TAG}"
fi

git tag -a "${TAG}" -m "Release ${TAG}"
git push origin HEAD
git push origin "${TAG}"

echo
echo "已推送 ${TAG}，Actions: https://github.com/codehyd/Knowledge-Base/actions"
echo "产物: https://github.com/codehyd/Knowledge-Base/releases"
