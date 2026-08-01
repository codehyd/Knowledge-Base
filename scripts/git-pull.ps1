# 通过本机代理拉取 GitHub（Clash 等）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/git-pull.ps1
param(
  [switch]$NoProxy,
  [string]$Remote = "origin",
  [string]$Branch = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not $Branch) {
  $Branch = (git symbolic-ref --short HEAD 2>$null)
  if (-not $Branch) { throw "当前不在分支上，请指定 -Branch" }
}

function Test-Proxy([string]$Proxy) {
  try {
    Invoke-WebRequest -Uri "https://github.com" -Proxy $Proxy -Method Head -TimeoutSec 3 -UseBasicParsing | Out-Null
    return $true
  } catch { return $false }
}

function Get-WorkingProxy {
  if ($env:GIT_PROXY) { return $env:GIT_PROXY }
  if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
  if ($env:https_proxy) { return $env:https_proxy }
  foreach ($port in 7897, 7890, 7892, 1087, 6152) {
    $p = "http://127.0.0.1:$port"
    if (Test-Proxy $p) { return $p }
  }
  return $null
}

$proxy = $null
if (-not $NoProxy) {
  $proxy = Get-WorkingProxy
  if ($proxy) { Write-Host "==> 使用代理：$proxy" }
  else {
    Write-Host "==> 未检测到可用代理，将直连"
    Write-Host "    可设置：`$env:GIT_PROXY='http://127.0.0.1:7897'"
  }
} else {
  Write-Host "==> 已禁用代理（-NoProxy）"
}

$gitCfg = @()
if ($proxy) {
  $gitCfg += "-c", "http.proxy=$proxy", "-c", "https.proxy=$proxy"
}

Write-Host "==> 拉取：$Remote $Branch"
git status -sb
& git @gitCfg fetch $Remote $Branch
& git @gitCfg pull --ff-only $Remote $Branch
git status -sb
Write-Host "最新提交：$(git log -1 --oneline)"
Write-Host "拉取完成。"
