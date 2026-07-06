# Remove the whatsapp-claude-bridge Windows Scheduled Task and stop the daemon.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1

$ErrorActionPreference = "SilentlyContinue"

$TaskName = "WhatsAppClaudeBridge"
$Repo = Split-Path -Parent $PSScriptRoot

schtasks /End /TN $TaskName 2>$null | Out-Null
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

# Kill any still-running instance (compiled binary by name; tsx scoped to this repo).
Get-Process -Name "wa-bridge-daemon" | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape($Repo) -and $_.CommandLine -match "index\.ts" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Removed scheduled task $TaskName and stopped the daemon (if it was running)."
