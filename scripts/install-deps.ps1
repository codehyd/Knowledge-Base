# 拉取代码后一键安装/更新依赖（前端 + Python API）
# 用法（在仓库根目录，PowerShell）：
#   .\scripts\install-deps.ps1
#   .\scripts\install-deps.ps1 -FreshVenv
param(
    [switch]$FreshVenv
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path "apps\api\requirements.txt")) {
    Write-Error "请在仓库根目录执行本脚本"
}

Write-Host "==> 空库 · 安装依赖（$Root）"

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "已创建 .env（可按需填入 LLM_API_KEY）"
}

New-Item -ItemType Directory -Force -Path "data\uploads", "data\exports", "data\tmp" | Out-Null

function Test-PythonVersion {
    param([string]$Exe)
    try {
        $ver = & $Exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        $parts = $ver.Trim().Split(".")
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        # 本项目依赖尚未适配 3.14+，锁定 3.12–3.13
        return ($major -eq 3 -and $minor -ge 12 -and $minor -le 13)
    } catch {
        return $false
    }
}

function Find-Python {
    $seen = @{}
    $candidateList = New-Object System.Collections.Generic.List[object]

    function Add-Candidate {
        param([string]$Cmd, [string]$Exe = "")
        if ([string]::IsNullOrWhiteSpace($Cmd)) { return }
        if ($seen.ContainsKey($Cmd)) { return }
        if ($Exe -and -not (Test-Path -LiteralPath $Exe)) { return }
        # 跳过 Microsoft Store 占位 python.exe
        if ($Exe -match 'WindowsApps\\python\.exe$') { return }
        $seen[$Cmd] = $true
        $candidateList.Add(@($Cmd, $Exe)) | Out-Null
    }

    try {
        $pyList = & py -0p 2>$null
        $ordered = New-Object System.Collections.Generic.List[object]
        foreach ($line in @($pyList)) {
            $isDefault = $line -match '\*'
            $ver = $null
            $exe = $null
            # 兼容默认标记行： -V:3.14 *        C:\...\python.exe
            if ($line -match '-V:(\S+)\s+\*\s+(.+\.exe)\s*$') {
                $ver = $matches[1]
                $exe = $matches[2].Trim()
                $isDefault = $true
            }
            elseif ($line -match '-V:(\S+)\s+(.+\.exe)\s*$') {
                $ver = $matches[1]
                $exe = $matches[2].Trim()
            }
            if (-not $ver -or -not $exe) { continue }
            if ($ver -match '(3\.\d+)') { $ver = $matches[1] } else { continue }
            $parts = $ver.Split(".")
            $major = [int]$parts[0]
            $minor = [int]$parts[1]
            if ($major -eq 3 -and $minor -ge 12 -and $minor -le 13) {
                $score = if ($isDefault) { 400 + $minor } else { 300 + $minor }
                $ordered.Add([pscustomobject]@{ Score = $score; Exe = $exe }) | Out-Null
            }
        }
        foreach ($item in ($ordered | Sort-Object Score -Descending)) {
            Add-Candidate $item.Exe $item.Exe
        }
    } catch { }

    # uv 已缓存的 3.12/3.13（不必再装官方安装包）
    $uvRoot = Join-Path $env:APPDATA "uv\python"
    if (Test-Path -LiteralPath $uvRoot) {
        Get-ChildItem -LiteralPath $uvRoot -Recurse -Filter "python.exe" -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 12 |
            ForEach-Object { Add-Candidate $_.FullName $_.FullName }
    }

    foreach ($name in @("python3.13", "python3.12", "python3", "python")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) {
            Add-Candidate $cmd.Source $cmd.Source
        }
    }

    # 本机常见安装路径（只扫 3.12 / 3.13）
    $pyRoot = Join-Path $env:LOCALAPPDATA "Programs\Python"
    if (Test-Path -LiteralPath $pyRoot) {
        Get-ChildItem -LiteralPath $pyRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^Python31[23]$' } |
            Sort-Object Name -Descending |
            ForEach-Object {
                $exe = Join-Path $_.FullName "python.exe"
                Add-Candidate $exe $exe
            }
    }

    foreach ($item in $candidateList) {
        $cmd = $item[0]
        $exe = $item[1]
        if ($exe -and (Test-PythonVersion $exe)) {
            return $exe
        }
        if (-not $exe -or $cmd -ne $exe) {
            try {
                if ($cmd -match '^py\s+') {
                    $ver = & cmd /c "$cmd -c `"import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')`"" 2>$null
                } else {
                    $ver = & $cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
                }
                if ($LASTEXITCODE -eq 0 -and $ver) {
                    $parts = $ver.Trim().Split(".")
                    $major = [int]$parts[0]
                    $minor = [int]$parts[1]
                    if ($major -eq 3 -and $minor -ge 12 -and $minor -le 13) {
                        return $cmd
                    }
                }
            } catch { }
        }
    }

    throw "需要 Python 3.12 或 3.13（依赖尚未适配 3.14+）。可用 uv python install 3.12，不必再装官方安装包。"
}

$pyCmd = Find-Python
$pyVer = (& $pyCmd --version 2>&1 | Out-String).Trim()
Write-Host "==> Python：$pyVer  ($pyCmd)"

$venv = "apps\api\.venv"
$venvPython = Join-Path $Root "apps\api\.venv\Scripts\python.exe"
$venvBroken = $false
if ((Test-Path $venv) -and -not $FreshVenv) {
    try {
        & $venvPython -c "import sys" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $venvBroken = $true
        } elseif (-not (Test-PythonVersion $venvPython)) {
            $venvBroken = $true
        }
    } catch {
        $venvBroken = $true
    }
}

if ($FreshVenv -and (Test-Path $venv)) {
    Write-Host "==> 重建虚拟环境（-FreshVenv）"
    Remove-Item -Recurse -Force $venv
} elseif ($venvBroken) {
    Write-Host "==> 现有虚拟环境不可用或版本不符（需要 3.12–3.13），自动重建"
    Remove-Item -Recurse -Force $venv
}

if (-not (Test-Path $venv)) {
    Write-Host "==> 创建 API 虚拟环境"
    & $pyCmd -m venv $venv
}

$venvPython = Join-Path $Root "apps\api\.venv\Scripts\python.exe"
& $venvPython -m pip install -U pip
& $venvPython -m pip install -r apps\api\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

function Install-NodeDeps {
    param([string]$Dir, [string]$Name)
    Write-Host "==> 安装 ${Name} 依赖：$Dir"
    Push-Location $Dir
    try {
        if (Get-Command pnpm -ErrorAction SilentlyContinue) {
            if (Test-Path "pnpm-lock.yaml") {
                pnpm install
                if ($Dir -like "*desktop*") {
                    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
                    node node_modules\electron\install.js 2>$null
                }
                return
            }
        }
        npm install --registry https://registry.npmmirror.com
    } finally {
        Pop-Location
    }
}

Install-NodeDeps "apps\web" "Web"
Install-NodeDeps "apps\desktop" "Desktop"

if ($env:INSTALL_SKIP_ASR_PREFETCH -ne "1") {
    Write-Host "==> 预下载 Whisper 语音模型（base，约 150MB；跳过：`$env:INSTALL_SKIP_ASR_PREFETCH=1）"
    $env:HF_ENDPOINT = if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT } else { "https://hf-mirror.com" }
    $env:HF_HUB_DISABLE_XET = "1"
    $env:HF_HUB_DOWNLOAD_TIMEOUT = "600"
    $env:DATA_DIR = Join-Path $Root "data"
    $py = Join-Path $Root "apps\api\.venv\Scripts\python.exe"
    & $py (Join-Path $Root "apps\api\scripts\prefetch_whisper.py")
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Whisper 模型预下载失败（不影响其它功能）。可稍后重试，或在设置里改用云端转写。"
    }
}

Write-Host ""
Write-Host "依赖安装完成。"
Write-Host ""
Write-Host "下一步："
Write-Host "  cd apps\desktop; npm run dev     # Electron 开发（推荐）"
Write-Host "  或 cd apps\web; npm run dev      # 仅网页"
Write-Host ""
Write-Host "若 API 仍报错，查看：data\api-dev.log"
