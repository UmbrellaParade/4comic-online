[CmdletBinding()]
param(
  [string]$TaskName = "Umbrella Parade VPS Manga Image Sync"
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "sync-vps-manga-images.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Sync script not found: $scriptPath"
}

try {
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Sync manga images from the Umbrella Parade VPS into the local Obsidian Folder at Windows logon." `
    -Force | Out-Null

  Write-Host "Registered scheduled task: $TaskName"
} catch {
  $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
  New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
  $startupBat = Join-Path $startupDir "Umbrella Parade VPS Manga Image Sync.bat"
  $bat = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$scriptPath"
"@
  Set-Content -LiteralPath $startupBat -Value $bat -Encoding ASCII
  Write-Host "Scheduled task registration was not allowed. Startup launcher was created instead:"
  Write-Host $startupBat
}
