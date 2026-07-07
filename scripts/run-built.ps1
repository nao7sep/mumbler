Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# run-built: launch the EXISTING packaged app without rebuilding, so it starts
# instantly. This is the daily-use launcher and the one that surfaces
# production-only failures (strict CSP, file:// paths, packaged layout). It never
# builds — if you changed source, run rebuild first.

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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$appName = "Mumbler"
$outDir = "dist"
$exePath = Join-Path $repoDir "$outDir/win-unpacked/$appName.exe"

try {
    Set-Utf8Console

    Set-Location $repoDir

    # No build here: this launcher must start instantly. If there is no usable
    # bundle yet, stop and point at rebuild rather than launching something stale
    # or empty.
    if (-not (Test-Path $exePath)) {
        throw "No packaged app found ($outDir/win-unpacked/$appName.exe is missing). Run rebuild first."
    }

    $builtAt = (Get-Item $exePath).LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    Write-Step "Launching the existing packaged app (built: $builtAt)"
    Write-Host "If you changed source since then, run rebuild instead."

    # GUI app: launch non-blocking via Start-Process.
    Start-Process -FilePath $exePath
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
