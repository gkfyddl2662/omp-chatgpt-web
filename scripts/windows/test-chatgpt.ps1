Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logPath = Join-Path $env:TEMP ("omp-chatgpt-web-chatgpt-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")
$transcriptStarted = $false
$exitCode = 0
$cdpPort = 9224
$cdpUrl = "http://127.0.0.1:$cdpPort"
$profileDir = Join-Path $HOME ".omp-chatgpt-web\cdp-browser-profile"
$expectedReply = "OMP CHATGPT WEB READY"

function Find-BrowserExecutable {
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:PROGRAMFILES "Google\Chrome\Application\chrome.exe"),
        $(if ($programFilesX86) { Join-Path $programFilesX86 "Google\Chrome\Application\chrome.exe" }),
        (Join-Path $env:PROGRAMFILES "Microsoft\Edge\Application\msedge.exe"),
        $(if ($programFilesX86) { Join-Path $programFilesX86 "Microsoft\Edge\Application\msedge.exe" })
    ) | Where-Object { $_ -and (Test-Path $_) }

    if ($candidates.Count -eq 0) {
        throw "Google Chrome or Microsoft Edge was not found."
    }

    return $candidates[0]
}

function Test-CdpReady {
    try {
        $null = Invoke-RestMethod -Uri "$cdpUrl/json/version" -TimeoutSec 2
        return $true
    }
    catch {
        return $false
    }
}

function Ensure-UserLaunchedBrowser {
    if (Test-CdpReady) {
        Write-Host "Existing dedicated Chrome/Edge debug session found at $cdpUrl"
        return
    }

    $browser = Find-BrowserExecutable
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

    Write-Host "Launching a normal Chrome/Edge process with a dedicated profile..."
    Write-Host "Browser: $browser"
    Write-Host "Profile: $profileDir"

    $arguments = @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$cdpPort",
        "--user-data-dir=$profileDir",
        "--no-first-run",
        "--no-default-browser-check",
        "https://chatgpt.com/?temporary-chat=true"
    )

    Start-Process -FilePath $browser -ArgumentList $arguments | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-CdpReady) { return }
        Start-Sleep -Milliseconds 250
    }

    throw "Chrome/Edge CDP endpoint did not become ready at $cdpUrl"
}

function Invoke-NodeCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $lines = @(& node @Arguments 2>&1)
    $code = $LASTEXITCODE

    foreach ($line in $lines) {
        Write-Host ([string]$line)
    }

    return @{
        ExitCode = $code
        Lines = $lines
        Text = ($lines -join [Environment]::NewLine)
    }
}

try {
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcriptStarted = $true

    Set-Location $repo

    Write-Host "=== Update ==="
    git fetch origin
    git checkout feat/bootstrap-native-mcp
    git pull --ff-only origin feat/bootstrap-native-mcp

    Write-Host ""
    Write-Host "=== Install / Verify ==="
    npm install --no-package-lock
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

    npm run verify
    if ($LASTEXITCODE -ne 0) { throw "npm run verify failed with exit code $LASTEXITCODE" }

    Write-Host ""
    Write-Host "=== User-Launched Browser / CDP ==="
    Ensure-UserLaunchedBrowser
    Write-Host "CDP ready: $cdpUrl"

    Write-Host ""
    Write-Host "=== Manual ChatGPT Login ==="
    Write-Host "IMPORTANT: Playwright is NOT attached yet."
    Write-Host "Use the opened normal Chrome/Edge window and finish ChatGPT login manually."
    Write-Host "If you use Google OAuth, complete it entirely in that browser."
    Write-Host "Wait until the normal ChatGPT message composer is visible."
    [void](Read-Host "When the ChatGPT composer is visible, press Enter here")

    $env:OMP_CHATGPT_WEB_CDP_URL = $cdpUrl
    $env:OMP_CHATGPT_WEB_PROFILE_DIR = $profileDir

    Write-Host ""
    Write-Host "=== ChatGPT Authentication Check ==="
    $auth = Invoke-NodeCapture -Arguments @("dist/cli.js", "browser-check")
    if ($auth.ExitCode -ne 0) {
        throw "ChatGPT authentication check failed with exit code $($auth.ExitCode)"
    }
    if ($auth.Text -notmatch '"authenticated"\s*:\s*true') {
        throw "ChatGPT authentication check did not report authenticated=true"
    }

    Write-Host ""
    Write-Host "=== ChatGPT Web Normal-Chat Probe ==="
    $chat = Invoke-NodeCapture -Arguments @(
        "dist/cli.js",
        "chat",
        "Reply with exactly: $expectedReply"
    )
    if ($chat.ExitCode -ne 0) {
        throw "ChatGPT chat probe failed with exit code $($chat.ExitCode)"
    }

    $matchedReply = $false
    foreach ($line in $chat.Lines) {
        if (([string]$line).Trim() -eq $expectedReply) {
            $matchedReply = $true
            break
        }
    }
    if (-not $matchedReply) {
        throw "ChatGPT response did not contain the exact expected line: $expectedReply"
    }

    Write-Host ""
    Write-Host "=== Git State ==="
    git status --short
    git rev-parse --short HEAD

    Write-Host ""
    Write-Host "=== RESULT: PASS ==="
}
catch {
    $exitCode = 1
    Write-Host ""
    Write-Host "=== RESULT: FAIL ==="
    Write-Host ($_ | Out-String)
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }

    if (Test-Path $logPath) {
        $text = Get-Content -Path $logPath -Raw
        try {
            Set-Clipboard -Value $text
            Write-Host ""
            Write-Host "Full test output copied to clipboard."
        }
        catch {
            Write-Host ""
            Write-Host "Could not copy to clipboard. Log saved at:"
            Write-Host $logPath
        }
    }
}

exit $exitCode
