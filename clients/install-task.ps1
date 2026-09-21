<#
.SYNOPSIS
  Registers the hourly, fully invisible scheduled task that runs report-usage.ps1.

.DESCRIPTION
  The task is created as "Run whether user is logged on or not" without a stored
  password (logon type S4U). Such a task runs in the background session, so no
  console window can ever appear - not even for a split second - and it keeps
  reporting when nobody is signed in.

  Creating an S4U task needs an elevated PowerShell ("Run as administrator"):

    powershell -ExecutionPolicy Bypass -File .\install-task.ps1
    powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Uninstall

  Without administrator rights use -Interactive. The task then runs only while
  you are signed in, with -WindowStyle Hidden; a window may flash briefly.

.PARAMETER ScriptPath
  Where report-usage.ps1 lives. Default: next to this file.

.PARAMETER IntervalMinutes
  How often to report. Keep it in step with REPORT_INTERVAL_MINUTES on the server.
#>
[CmdletBinding()]
param(
  [string]$ScriptPath = (Join-Path $PSScriptRoot 'report-usage.ps1'),
  [string]$TaskName = 'usageratio-report',
  [ValidateRange(5, 1440)][int]$IntervalMinutes = 60,
  [switch]$Interactive,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the scheduled task '$TaskName'."
  } else {
    Write-Host "There is no scheduled task named '$TaskName'."
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "report-usage.ps1 was not found at: $ScriptPath"
}
$ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Interactive -and -not $isAdmin) {
  throw 'Run this from an elevated PowerShell (Run as administrator), or add -Interactive.'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

# Daily at midnight, repeating all day: the most portable way to say "every N minutes, forever".
$trigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$repeat = New-ScheduledTaskTrigger -Once -At '00:00' `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 1)
$trigger.Repetition = $repeat.Repetition

$logonType = 'S4U'
if ($Interactive) { $logonType = 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType $logonType -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description 'Reports Deepseek token usage to usageratio every hour.' | Out-Null

Write-Host "Registered '$TaskName': every $IntervalMinutes minutes as $($identity.Name) ($logonType)."
Write-Host "Try it now:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Then check:   Get-Content `"$env:USERPROFILE\.usageratio\usageratio.log`" -Tail 5"
