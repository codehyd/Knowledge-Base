#!/usr/bin/env bash
# 全量 Compose 启动（镜像默认走 DaoCloud 加速）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

mkdir -p data/uploads data/exports data/tmp

export DOCKER_HUB_PROXY="${DOCKER_HUB_PROXY:-docker.m.daocloud.io}"
echo "镜像代理: $DOCKER_HUB_PROXY"

DOCKER_BUILDKIT=1 docker compose up -d --build "$@"
docker compose ps
echo ""
echo "网页 http://localhost:18080  |  API文档 http://localhost:18765/doc.html (Knife4j)"
