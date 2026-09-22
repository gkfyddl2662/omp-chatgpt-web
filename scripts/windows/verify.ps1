Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logPath = Join-Path $env:TEMP ("omp-chatgpt-web-verify-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")
$transcriptStarted = $false
$exitCode = 0

try {
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcriptStarted = $true

    Set-Location $repo

    Write-Host "=== Versions ==="
    git --version
    node --version
    npm --version

    Write-Host ""
    Write-Host "=== Install ==="
    npm install --no-package-lock
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

    Write-Host ""
    Write-Host "=== Verify ==="
    npm run verify
    if ($LASTEXITCODE -ne 0) { throw "npm run verify failed with exit code $LASTEXITCODE" }

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
            Write-Host "Full validation output copied to clipboard."
        }
        catch {
            Write-Host ""
            Write-Host "Could not copy to clipboard. Log saved at:"
            Write-Host $logPath
        }
    }
}

exit $exitCode
