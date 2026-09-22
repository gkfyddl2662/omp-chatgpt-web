# Windows local validation

Current bootstrap validation checks the TypeScript project, fail-closed backend
policy, and capability-broker lifecycle. ChatGPT Web/browser/MCP integration is
not implemented yet.

## Prerequisites

- Windows PowerShell 5.1 or PowerShell 7+
- Git
- Node.js 22+ with npm

## One-shot validation

Run PowerShell as your normal user:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$ErrorActionPreference = "Stop"

$repo = Join-Path $HOME "omp-chatgpt-web"
if (Test-Path $repo) {
  Set-Location $repo
  git fetch origin
} else {
  git clone https://github.com/gkfyddl2662/omp-chatgpt-web.git $repo
  Set-Location $repo
}

git checkout feat/bootstrap-native-mcp
git pull --ff-only origin feat/bootstrap-native-mcp

Write-Host "=== Versions ==="
git --version
node --version
npm --version

Write-Host "=== Install ==="
npm install

Write-Host "=== Verify ==="
npm run verify

Write-Host "=== Git state ==="
git status --short
git rev-parse --short HEAD
```

Expected success marker:

```text
bootstrap smoke verification: PASS
```

If validation fails, copy the complete PowerShell output from `=== Versions ===`
through the error and return it for diagnosis.
