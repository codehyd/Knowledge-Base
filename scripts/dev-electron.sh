#!/usr/bin/env bash
# 兼容旧入口：转发到 apps/desktop 的 npm run dev（会自动起 Vite）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/desktop"
npm run dev
