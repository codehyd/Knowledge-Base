# 本地打包桌面端（不推送 GitHub；默认 --publish never）
#
# 用法（仓库根目录）：
#   .\scripts\pack-desktop.ps1 win
#   .\scripts\pack-desktop.ps1 mac
#   .\scripts\pack-desktop.ps1 linux
#   .\scripts\pack-desktop.ps1 all
#   .\scripts\pack-desktop.ps1 win -SkipSidecar
#   .\scripts\pack-desktop.ps1 win -SkipWeb
#   .\scripts\pack-desktop.ps1 win -Dir
#
# 产物：apps/desktop/release/

[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("win", "windows", "mac", "macos", "linux", "all")]
  [string]$Target,

  [switch]$SkipSidecar,
  [switch]$SkipWeb,
  [switch]$Dir,
  [string]$Publish = "never"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not (Test-Path "apps/desktop/package.json")) {
  throw "未找到 apps/desktop/package.json，请在仓库根执行。"
}

switch ($Target) {
  "windows" { $Target = "win" }
  "macos" { $Target = "mac" }
}

function Get-HostKind {
  if ($IsWindows -or $env:OS -match "Windows") { return "win" }
  if ($IsMacOS) { return "mac" }
  if ($IsLinux) { return "linux" }
  return "unknown"
}

function Resolve-ElectronArgs([string]$Kind) {
  $args = switch ($Kind) {
    "win" { @("--win", "--x64") }
    "mac" { @("--mac", "--x64", "--arm64") }
    "linux" { @("--linux", "--x64") }
  }
  if ($Dir) { $args += "--dir" }
  return $args
}

function Write-CrossWarn([string]$Kind) {
  $hostKind = Get-HostKind
  if ($hostKind -eq "unknown") { return }
  if ($Kind -ne "all" -and $Kind -ne $hostKind) {
    Write-Warning "当前系统是 $hostKind，正在打 $Kind 包；跨平台可能失败。"
    Write-Warning "完整三端请用 .\scripts\release-desktop.ps1 推 tag 触发 GitHub Actions。"
  }
  if ($Kind -eq "all") {
    Write-Warning "all 会在本机连续打三端，非当前系统的目标通常会失败。"
  }
}

function Get-ApiPython {
  $winPy = Join-Path $Root "apps/api/.venv/Scripts/python.exe"
  $unixPy = Join-Path $Root "apps/api/.venv/bin/python"
  if (Test-Path $winPy) { return $winPy }
  if (Test-Path $unixPy) { return $unixPy }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "未找到 Python / apps/api/.venv"
}

function Build-Sidecar {
  Write-Host "==> 1/3 构建 API sidecar"
  $py = Get-ApiPython
  & $py -m pip install -q -r (Join-Path $Root "apps/api/requirements.txt") pyinstaller
  Push-Location (Join-Path $Root "apps/api")
  try {
    & $py scripts/build_sidecar.py
  } finally {
    Pop-Location
  }
  $exe = Join-Path $Root "apps/desktop/resources/api/kongku-api.exe"
  $bin = Join-Path $Root "apps/desktop/resources/api/kongku-api"
  if (Test-Path $exe) {
    Write-Host "sidecar ok: $exe"
  } elseif (Test-Path $bin) {
    Write-Host "sidecar ok: $bin"
  } else {
    throw "sidecar 未生成：apps/desktop/resources/api/"
  }
}

function Build-Web {
  Write-Host "==> 2/3 构建前端 (ELECTRON=1)"
  Push-Location (Join-Path $Root "apps/web")
  try {
    if (-not (Test-Path "node_modules")) { npm ci }
    $env:ELECTRON = "1"
    npm run build
  } finally {
    Pop-Location
  }
  if (-not (Test-Path (Join-Path $Root "apps/web/dist/index.html"))) {
    throw "前端构建失败：缺少 apps/web/dist/index.html"
  }
  Write-Host "web ok: apps/web/dist"
}

function Build-Electron([string]$Kind) {
  $ebArgs = Resolve-ElectronArgs $Kind
  Write-Host ("==> 3/3 electron-builder {0}: {1} --publish {2}" -f $Kind, ($ebArgs -join " "), $Publish)
  Push-Location (Join-Path $Root "apps/desktop")
  try {
    if (-not (Test-Path "node_modules")) { npm install }
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    $npxArgs = @("electron-builder") + $ebArgs + @("--publish", $Publish)
    & npx @npxArgs
    if ($LASTEXITCODE -ne 0) {
      throw "electron-builder 失败，exit=$LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

Write-CrossWarn $Target

if (-not $SkipSidecar) { Build-Sidecar } else { Write-Host "==> 跳过 sidecar (-SkipSidecar)" }
if (-not $SkipWeb) { Build-Web } else { Write-Host "==> 跳过前端 (-SkipWeb)" }

if ($Target -eq "all") {
  foreach ($t in @("win", "mac", "linux")) {
    Write-Host ""
    Write-Host "======== 打包 $t ========"
    try {
      Write-CrossWarn $t
      Build-Electron $t
    } catch {
      Write-Warning "$t 打包失败：$($_.Exception.Message)"
    }
  }
} else {
  Build-Electron $Target
}

Write-Host ""
Write-Host "完成。产物目录：$Root\apps\desktop\release"
Get-ChildItem (Join-Path $Root "apps/desktop/release") -ErrorAction SilentlyContinue |
  Select-Object Name, @{N = "SizeMB"; E = { [math]::Round($_.Length / 1MB, 1) } } |
  Format-Table -AutoSize
