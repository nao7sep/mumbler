Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# rebuild: produce a fresh PRODUCTION build (release configuration) and launch
# it. Slow — run this after changing source. The build runs the production type
# checks the release build runs and re-bundles from clean, so type, import, CSP,
# and packaged-layout errors that run-dev hides surface here. run-built is the
# fast, no-build launcher for everything after this.

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
    Require-Command npm

    Set-Location $repoDir

    Write-Step "Installing dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install")

    # npm install skips the Electron binary if the package is already at the locked version.
    Write-Step "Verifying Electron binary"
    if (-not (Test-Path "node_modules/electron/path.txt")) {
        Write-Host "Electron binary missing; downloading..."
        Invoke-Native -FilePath "node" -ArgumentList @("node_modules/electron/install.js")
    }

    # Remove stale output so a build that fails to emit a file can't be masked by
    # a leftover artifact from a previous run.
    Write-Step "Cleaning previous production build"
    if (Test-Path "out") { Remove-Item -Recurse -Force "out" }

    # The release build type-checks the shipped sources (main/preload + renderer);
    # the dev server skips this entirely. Tests are checked separately and are not
    # part of the release build, so they are not gated here.
    Write-Step "Type-checking production sources (node + web)"
    Invoke-Native -FilePath "node_modules/.bin/tsc.cmd" -ArgumentList @("--noEmit", "-p", "tsconfig.node.json")
    Invoke-Native -FilePath "node_modules/.bin/tsc.cmd" -ArgumentList @("--noEmit", "-p", "tsconfig.web.json")

    Write-Step "Building production bundle"
    Invoke-Native -FilePath "node_modules/.bin/electron-vite.cmd" -ArgumentList @("build")

    # preview runs the built main against the built renderer over file://, so the
    # production Content-Security-Policy and packaged-layout paths are exercised
    # as in a release.
    Write-Step "Launching the production build"
    Invoke-Native -FilePath "node_modules/.bin/electron-vite.cmd" -ArgumentList @("preview") -AllowedExitCodes @(0, 130, -1073741510)
}
catch {
    Write-Host ""
    Write-Host "mumbler rebuild failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
