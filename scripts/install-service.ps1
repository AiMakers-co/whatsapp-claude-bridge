# Install whatsapp-claude-bridge as a Windows Scheduled Task so it starts on
# login, runs in the background, and restarts itself if it crashes.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#         (re-run any time to update paths / reload)
#
# Mirrors scripts/install-service.sh (launchd) for Windows. Runs the compiled
# daemon binary (dist-bin\wa-bridge-daemon.exe) if present, otherwise falls
# back to node + tsx from the repo's node_modules.

$ErrorActionPreference = "Stop"

$TaskName = "WhatsAppClaudeBridge"
$Repo = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Repo "logs"
$LogFile = Join-Path $LogDir "service.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ── Pick what to run ─────────────────────────────────────────────────────────
$CompiledBin = Join-Path $Repo "dist-bin\wa-bridge-daemon.exe"
$Tsx = Join-Path $Repo "node_modules\.bin\tsx.cmd"

if (Test-Path $CompiledBin) {
    $RunLine = "`"$CompiledBin`""
    Write-Host "Using compiled daemon binary: $CompiledBin"
} else {
    $Node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $Node) {
        Write-Error "Neither dist-bin\wa-bridge-daemon.exe nor node found. Install Node >=20 or build the binary first."
        exit 1
    }
    if (-not (Test-Path $Tsx)) {
        Write-Error "Dependencies missing. Run 'npm install' in $Repo first."
        exit 1
    }
    $RunLine = "`"$Tsx`" src/index.ts"
    Write-Host "Using tsx from node_modules (no compiled binary found)."
}

# ── Stop anything already running ────────────────────────────────────────────
# Never let two processes fight over the same WhatsApp session.
schtasks /End /TN $TaskName 2>$null | Out-Null
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

# Kill a lingering manually-started instance (compiled binary by name; tsx by
# command line scoped to THIS repo so unrelated node processes are untouched).
Get-Process -Name "wa-bridge-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match [regex]::Escape($Repo) -and $_.CommandLine -match "index\.ts" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ── Register the task ────────────────────────────────────────────────────────
# cmd /c wrapper so stdout/stderr land in logs\service.log (the app also writes
# its own logs\bridge.log).
$Action = New-ScheduledTaskAction -Execute "cmd.exe" `
    -Argument "/c cd /d `"$Repo`" && $RunLine >> `"$LogFile`" 2>&1" `
    -WorkingDirectory $Repo

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "whatsapp-claude-bridge daemon (auto-start on login, restart on crash)" | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "  Runs:   $RunLine"
Write-Host "  Logs:   $LogFile  (app log: $Repo\logs\bridge.log)"
Write-Host ""
Write-Host "It now runs in the background and on every login."
Write-Host "Status:  schtasks /Query /TN $TaskName"
Write-Host "Stop:    powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1"
