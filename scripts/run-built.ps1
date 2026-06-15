Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# run-built: launch the EXISTING production build without rebuilding, so it
# starts instantly. This is the daily-use launcher and the one that surfaces
# production-only failures (strict CSP, file:// paths, packaged layout). It
# never builds — if you changed source, run rebuild first.

function Set-Utf8Console {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $global:OutputEncoding = $utf8NoBom
    if (Get-Command chcp.com -ErrorAction SilentlyContinue) {
        & chcp.com 65001 > $null
        $null = $LASTEXITCODE
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$AllowedExitCodes = @(0)
    )

    & $FilePath @ArgumentList
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    if ($AllowedExitCodes -notcontains $exitCode) {
        throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir

try {
    Set-Utf8Console
    Require-Command node

    Set-Location $repoDir

    # No build, no dependency install here: this launcher must start instantly. If
    # there is no usable build yet, stop and point at rebuild rather than launching
    # something stale or empty.
    if (-not ((Test-Path "out/renderer/index.html") -and (Test-Path "out/main") -and (Test-Path "node_modules/.bin/electron-vite.cmd"))) {
        throw "No production build found (out/ is missing or incomplete, or dependencies are not installed). Run rebuild first."
    }

    $builtAt = (Get-Item "out/renderer/index.html").LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    Write-Step "Launching the existing production build (built: $builtAt)"
    Write-Host "If you changed source since then, run rebuild instead."

    Invoke-Native -FilePath "node_modules/.bin/electron-vite.cmd" -ArgumentList @("preview") -AllowedExitCodes @(0, 130, -1073741510)
}
catch {
    Write-Host ""
    Write-Host "mumbler run-built failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
