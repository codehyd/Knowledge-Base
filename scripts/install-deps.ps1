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
        return ($major -eq 3 -and $minor -ge 12)
    } catch {
        return $false
    }
}

function Find-Python {
    $seen = @{}

    function Add-Candidate {
        param([string]$Cmd, [string]$Exe = "")
        if ($seen.ContainsKey($Cmd)) { return }
        if ($Exe -and -not (Test-Path $Exe)) { return }
        $seen[$Cmd] = $true
        $script:candidateList += ,@($Cmd, $Exe)
    }

    $candidateList = @()
    try {
        $pyList = & py -0p 2>$null
        foreach ($line in $pyList) {
            if ($line -match '-V:(\d+\.\d+)\s+(.+\.exe)\s*$') {
                $ver = $matches[1]
                $exe = $matches[2].Trim()
                $parts = $ver.Split(".")
                $major = [int]$parts[0]
                $minor = [int]$parts[1]
                if ($major -eq 3 -and $minor -ge 12) {
                    Add-Candidate "py -$ver" $exe
                }
            }
        }
    } catch { }

    foreach ($name in @("python3.12", "python3.13", "python3.14", "python3", "python")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            Add-Candidate $cmd.Source $cmd.Source
        }
    }

    foreach ($item in $candidateList) {
        $cmd = $item[0]
        $exe = $item[1]
        if ($exe -and (Test-PythonVersion $exe)) {
            return $cmd
        }
        if (-not $exe) {
            try {
                $ver = & cmd /c "$cmd -c `"import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')`"" 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $parts = $ver.Trim().Split(".")
                    $major = [int]$parts[0]
                    $minor = [int]$parts[1]
                    if ($major -eq 3 -and $minor -ge 12) {
                        return $cmd
                    }
                }
            } catch { }
        }
    }

    throw "需要 Python 3.12 或更高版本。可从 https://www.python.org/downloads/ 安装，并勾选 Add to PATH"
}

$pyCmd = Find-Python
Write-Host "==> Python：$(& cmd /c "$pyCmd --version")"

$venv = "apps\api\.venv"
if ($FreshVenv -and (Test-Path $venv)) {
    Write-Host "==> 重建虚拟环境"
    Remove-Item -Recurse -Force $venv
}

if (-not (Test-Path $venv)) {
    Write-Host "==> 创建 API 虚拟环境"
    & cmd /c "$pyCmd -m venv $venv"
}

$pip = Join-Path $Root "apps\api\.venv\Scripts\pip.exe"
& $pip install -U pip
& $pip install -r apps\api\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

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
