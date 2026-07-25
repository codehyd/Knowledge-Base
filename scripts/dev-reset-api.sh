#!/usr/bin/env bash
# 开发态 API 卡住时：结束 18765 端口进程，便于重新 npm run dev
set -euo pipefail

PORT="${KONGKU_API_PORT:-18765}"
echo "==> 清理占用 ${PORT} 的 API 进程"

pids="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -z "${pids}" ]]; then
  echo "端口 ${PORT} 无监听进程"
  exit 0
fi

echo "${pids}" | tr ' ' '\n' | while read -r pid; do
  [[ -z "${pid}" ]] && continue
  echo "  kill ${pid}"
  kill "${pid}" 2>/dev/null || true
done

sleep 0.5
if lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "仍有进程，强制 kill -9"
  lsof -ti "tcp:${PORT}" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
fi

echo "完成。请重新执行：cd apps/desktop && npm run dev"
