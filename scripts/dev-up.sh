#!/usr/bin/env bash
# 快速开发启动：只拉/起 DB，本机跑 API + Web（比全量 compose build 快很多）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "已创建 .env，可稍后填入 LLM_API_KEY"
fi

mkdir -p data/uploads data/exports data/tmp

# 本机已有 postgres 镜像时优先复用，避免再拉 pgvector
if docker image inspect postgres:16-alpine >/dev/null 2>&1; then
  export POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
  echo "使用本机已有镜像: $POSTGRES_IMAGE"
fi

echo "==> 启动数据库"
docker compose -f docker-compose.dev.yml up -d

echo "==> 等待数据库就绪"
for i in $(seq 1 30); do
  if docker compose -f docker-compose.dev.yml exec -T db pg_isready -U kongku -d kongku >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ ! -d apps/api/.venv ]]; then
  echo "==> 创建 API 虚拟环境并安装依赖"
  python3 -m venv apps/api/.venv
  # shellcheck disable=SC1091
  source apps/api/.venv/bin/activate
  pip install -r apps/api/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
else
  # shellcheck disable=SC1091
  source apps/api/.venv/bin/activate
fi

if [[ ! -d apps/web/node_modules ]]; then
  echo "==> 安装前端依赖"
  (cd apps/web && npm install --registry https://registry.npmmirror.com)
fi

echo "==> 启动 API (8000) 与 Web (5173)"
export DATABASE_URL="${DATABASE_URL:-postgresql+asyncpg://kongku:kongku@127.0.0.1:5432/kongku}"
export API_CORS_ORIGINS="${API_CORS_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173}"

uvicorn app.main:app --app-dir apps/api --reload --host 127.0.0.1 --port 8000 &
API_PID=$!
(cd apps/web && npm run dev -- --host 127.0.0.1 --port 5173) &
WEB_PID=$!

cleanup() {
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo ""
echo "已启动："
echo "  网页  http://127.0.0.1:5173"
echo "  API   http://127.0.0.1:8000/docs"
echo "  健康  http://127.0.0.1:8000/health"
echo "按 Ctrl+C 结束本机 API/Web（数据库容器仍保留）"
wait
