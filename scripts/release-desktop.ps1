# 桌面端发版：打 v* tag 并推送，触发 GitHub Actions「Release Desktop」
#
# 用法（在仓库根目录）：
#   .\scripts\release-desktop.ps1              # 默认 patch 自增，如 v0.1.0 -> v0.1.1
#   .\scripts\release-desktop.ps1 -Bump minor  # 0.1.0 -> 0.2.0
#   .\scripts\release-desktop.ps1 -Bump major  # 0.1.0 -> 1.0.0
#   .\scripts\release-desktop.ps1 0.3.0        # 指定版本（可带或不带 v）
#   .\scripts\release-desktop.ps1 -DryRun     # 只打印，不改仓库

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Version,

  [ValidateSet("patch", "minor", "major")]
  [string]$Bump = "patch",

  [switch]$DryRun,

  [switch]$Force
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

Write-Host "==> 同步远程标签（避免换机器时本地 tag 不全）"
git fetch origin --tags --prune 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "警告：fetch tags 失败，将仅根据本地 tag / package.json 计算版本" -ForegroundColor Yellow
}

function Get-LatestSemverTag {
  $tags = git tag -l "v*" --sort=-v:refname 2>$null
  if (-not $tags) { return $null }
  $first = ($tags | Select-Object -First 1)
  if ($first -match '^v(\d+)\.(\d+)\.(\d+)$') {
    return [pscustomobject]@{
      Raw = $first
      Major = [int]$Matches[1]
      Minor = [int]$Matches[2]
      Patch = [int]$Matches[3]
    }
  }
  return $null
}

function Get-PackageVersion {
  $pkgPath = Join-Path $Root "apps/desktop/package.json"
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  if ($pkg.version -match '^(\d+)\.(\d+)\.(\d+)$') {
    return [pscustomobject]@{
      Raw = "v$($pkg.version)"
      Major = [int]$Matches[1]
      Minor = [int]$Matches[2]
      Patch = [int]$Matches[3]
    }
  }
  return [pscustomobject]@{ Raw = "v0.0.0"; Major = 0; Minor = 0; Patch = 0 }
}

function Format-Version($m, $n, $p) {
  return "$m.$n.$p"
}

# --- 解析目标版本 ---
$next = $null
if ($Version) {
  $v = $Version.Trim()
  if ($v.StartsWith("v")) { $v = $v.Substring(1) }
  if ($v -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "版本号格式应为 x.y.z，例如 0.1.1 或 v0.1.1"
  }
  $next = Format-Version ([int]$Matches[1]) ([int]$Matches[2]) ([int]$Matches[3])
} else {
  $base = Get-LatestSemverTag
  if (-not $base) { $base = Get-PackageVersion }
  $maj = $base.Major
  $min = $base.Minor
  $pat = $base.Patch
  switch ($Bump) {
    "major" { $maj++; $min = 0; $pat = 0 }
    "minor" { $min++; $pat = 0 }
    default { $pat++ }
  }
  $next = Format-Version $maj $min $pat
  Write-Host "基于 $($base.Raw) 按 -$Bump 自增 -> v$next"
}

$tag = "v$next"
$exists = git rev-parse -q --verify "refs/tags/$tag" 2>$null
if ($LASTEXITCODE -eq 0 -and $exists) {
  throw "标签已存在：$tag ，请换版本或删除旧 tag"
}

# --- 工作区检查 ---
$status = git status --porcelain
if ($status -and -not $Force) {
  Write-Host "工作区有未提交改动：" -ForegroundColor Yellow
  git status -sb
  throw "请先提交或暂存后再发版；若确认忽略可用 -Force"
}

# --- 更新 package.json 版本 ---
$pkgPath = Join-Path $Root "apps/desktop/package.json"
$pkgText = Get-Content $pkgPath -Raw
$pkgNew = [regex]::Replace(
  $pkgText,
  '"version"\s*:\s*"[^"]+"',
  "`"version`": `"$next`"",
  1
)
if ($pkgNew -eq $pkgText) {
  Write-Host "package.json 版本已是 $next ，跳过改写"
} else {
  Write-Host "更新 apps/desktop/package.json -> $next"
  if (-not $DryRun) {
    Set-Content -Path $pkgPath -Value $pkgNew -NoNewline -Encoding utf8
  }
}

if ($DryRun) {
  Write-Host "[DryRun] 将执行："
  Write-Host "  git add apps/desktop/package.json && git commit -m `"chore(desktop): release $tag`""
  Write-Host "  git tag $tag"
  Write-Host "  git push origin HEAD"
  Write-Host "  git push origin $tag"
  Write-Host "然后打开 https://github.com/codehyd/Knowledge-Base/actions"
  exit 0
}

# --- 提交版本号（若有变更）---
git add apps/desktop/package.json
$staged = git diff --cached --name-only
if ($staged) {
  git commit -m "chore(desktop): release $tag"
  Write-Host "已提交版本号变更"
}

# --- 打 tag 并推送 ---
git tag -a $tag -m "Release $tag"
Write-Host "已创建标签 $tag"

git push origin HEAD
if ($LASTEXITCODE -ne 0) { throw "推送分支失败" }

git push origin $tag
if ($LASTEXITCODE -ne 0) { throw "推送标签失败" }

Write-Host ""
Write-Host "已推送 $tag ，GitHub Actions 将开始打包。" -ForegroundColor Green
Write-Host "进度：https://github.com/codehyd/Knowledge-Base/actions"
Write-Host "产物：https://github.com/codehyd/Knowledge-Base/releases"
