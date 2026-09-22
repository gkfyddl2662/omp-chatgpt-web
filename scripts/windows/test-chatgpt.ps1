Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logPath = Join-Path $env:TEMP ("omp-chatgpt-web-chatgpt-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")
$transcriptStarted = $false
$exitCode = 0

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
    Write-Host "=== ChatGPT Web Login ==="
    Write-Host "A managed Chrome/Edge window will open."
    Write-Host "If ChatGPT asks you to sign in, complete the login in that window."
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
