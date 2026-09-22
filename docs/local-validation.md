# Windows local validation

Validation scripts are designed for Windows PowerShell 5.1 and PowerShell 7+.
They capture the complete transcript and copy it to the clipboard at the end,
including failure output.

## Prerequisites

- Git
- Node.js 22+ with npm
- Google Chrome or Microsoft Edge for the ChatGPT Web probe

## Bootstrap verification

From the repository root:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
& .\scripts\windows\verify.ps1
```

Expected marker:

```text
bootstrap smoke verification: PASS
=== RESULT: PASS ===
Full validation output copied to clipboard.
```

## Phase 1 ChatGPT Web probe

This opens a project-owned persistent Chrome/Edge profile under
`~/.omp-chatgpt-web/browser-profile`.

If ChatGPT asks for authentication, complete the login in that managed browser
window. The probe then creates a normal Temporary Chat and sends a deterministic
test prompt.

Run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
& .\scripts\windows\test-chatgpt.ps1
```

Expected assistant text:

```text
OMP CHATGPT WEB READY
```

The script then copies its complete transcript to the clipboard. Paste that
transcript into the development chat for the next iteration.

## Current scope

The Phase 1 browser probe verifies only:

```text
local runtime -> normal ChatGPT Web Temporary Chat -> assistant text
```

It does not yet integrate the browser runtime into OMP's provider registry and
does not yet start the Secure MCP Tunnel. Those are subsequent milestones.
