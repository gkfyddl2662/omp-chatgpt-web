Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logPath = Join-Path $env:TEMP ("omp-chatgpt-web-chatgpt-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")
$transcriptStarted = $false
$exitCode = 0
$cdpPort = 9223
$cdpUrl = "http://127.0.0.1:$cdpPort"
$profileDir = Join-Path $HOME ".omp-chatgpt-web\browser-profile"

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
    $env:OMP_CHATGPT_WEB_CDP_URL = $cdpUrl
    Write-Host "CDP ready: $cdpUrl"

    Write-Host ""
    Write-Host "=== ChatGPT Web Login ==="
    Write-Host "Use the opened normal Chrome/Edge window."
    Write-Host "If ChatGPT asks you to sign in, complete the login there."
    npm run chatgpt:login
    if ($LASTEXITCODE -ne 0) { throw "ChatGPT login probe failed with exit code $LASTEXITCODE" }

    Write-Host ""
    Write-Host "=== ChatGPT Web Normal-Chat Probe ==="
    npm run chatgpt:chat -- "Reply with exactly: OMP CHATGPT WEB READY"
    if ($LASTEXITCODE -ne 0) { throw "ChatGPT chat probe failed with exit code $LASTEXITCODE" }

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
