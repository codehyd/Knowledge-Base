#!/usr/bin/env bash
# 个人版开发提示（已不再启动 Docker）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "已创建 .env，可稍后填入 LLM_API_KEY"
fi

mkdir -p data/uploads data/exports data/tmp

cat <<'EOF'
空库 · 个人版（默认 SQLite，无 Docker）

推荐 Electron：
  cd apps/desktop && npm run dev

仅网页：
  终端1: cd apps/web && npm run dev
  终端2: cd apps/api && source .venv/bin/activate && uvicorn app.main:app --reload --port 18765

数据文件: data/kongku.db
EOF
