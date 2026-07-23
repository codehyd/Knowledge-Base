# 兼容旧入口：转发到 apps/desktop 的 npm run dev（会自动起 Vite）
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location (Join-Path $Root "apps\desktop")
npm run dev
