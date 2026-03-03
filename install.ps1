#!/usr/bin/env pwsh
# Lucid MCP Server -- Windows Installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
#   OR:  .\install.ps1  (din PowerShell)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Prompt-YN {
    param([string]$Message, [string]$Default = "N")
    $hint = if ($Default -eq "Y") { "[Y/n]" } else { "[y/N]" }
    $ans = Read-Host "$Message $hint"
    if ($ans -eq "") { $ans = $Default }
    return $ans -match "^[Yy]$"
}

Write-Host ""
Write-Host "======================================"
Write-Host "   Lucid MCP Server -- Installer"
Write-Host "======================================"
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Build MCP server
# ---------------------------------------------------------------------------
Write-Host "> Installing MCP server dependencies..."
Write-Host "  (better-sqlite3 compileaza nativ -- poate dura 1-2 min, asteptati...)"
Set-Location $ScriptDir
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }

Write-Host "> Building MCP server..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "npm run build failed"; exit 1 }
Write-Host "[OK] MCP server built -> build/index.js"
Write-Host ""

# ---------------------------------------------------------------------------
# 2. Register MCP server with Claude Code (optional)
# ---------------------------------------------------------------------------
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    if (Prompt-YN "Register Lucid as Claude Code MCP server?" "Y") {
        $nodeArg = "$ScriptDir\build\index.js"
        claude mcp add --transport stdio lucid -- node $nodeArg
        Write-Host "[OK] Registered: lucid -> node $nodeArg"
    } else {
        Write-Host "[--] Skipped MCP registration (run manually later)"
        Write-Host "     claude mcp add --transport stdio lucid -- node `"$ScriptDir\build\index.js`""
    }
} else {
    Write-Host "[!]  claude CLI not found -- register manually after install:"
    Write-Host "     claude mcp add --transport stdio lucid -- node `"$ScriptDir\build\index.js`""
}
Write-Host ""

# ---------------------------------------------------------------------------
# 3. Web Dev Cycle Manager (optional)
# ---------------------------------------------------------------------------
Write-Host "+----------------------------------------------------------+"
Write-Host "|  Web Dev Cycle Manager                                   |"
Write-Host "|  Express API (port 3001) + React/Vite UI (port 5173)     |"
Write-Host "|  Vizualizare planuri, task-uri si HTTP tests din browser |"
Write-Host "+----------------------------------------------------------+"
Write-Host ""

if (Prompt-YN "Install Web Dev Cycle Manager?" "N") {
    $WebDir = Join-Path $ScriptDir "web"

    if (-not (Test-Path $WebDir)) {
        Write-Error "Directory $WebDir not found"
        exit 1
    }

    Write-Host ""
    Write-Host "> Installing web dependencies..."
    Write-Host "  (better-sqlite3 + Vite compileaza -- poate dura 2-3 min, asteptati...)"
    Set-Location $WebDir
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install (web) failed"; exit 1 }
    Write-Host "[OK] Web dependencies installed"

    Write-Host ""
    $built = Prompt-YN "Build web for production now?" "N"
    if ($built) {
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Error "npm run build (web) failed"; exit 1 }
        Write-Host "[OK] Web built -> dist/client/ + dist/server/"
    }

    Write-Host ""
    Write-Host "[OK] Web Dev Cycle Manager gata!"
    Write-Host ""
    Write-Host "   Start (development):"
    Write-Host "   Terminal 1:  cd lucid\web ; npm run dev:server   # API port 3001"
    Write-Host "   Terminal 2:  cd lucid\web ; npm run dev:client   # UI  port 5173"
    Write-Host ""
    Write-Host "   Sau din lucid\:"
    Write-Host "   npm run web:server"
    Write-Host "   npm run web:client"

    if ($built) {
        Write-Host ""
        Write-Host "   Start (production):"
        Write-Host "   cd lucid\web ; npm start    # API port 3001"
    }
} else {
    Write-Host "[--] Web UI skipped"
    Write-Host "     Pentru a instala mai tarziu: .\install.ps1"
}

Write-Host ""
Write-Host "======================================"
Write-Host "   [OK] Instalare completa!"
Write-Host "======================================"
Write-Host ""
