<#
.SYNOPSIS
  usageratio - reports this machine's Codex token usage to the dashboard (Windows).

.DESCRIPTION
  Works on Windows PowerShell 5.1 and PowerShell 7+, needs nothing else.
  Run hourly and invisibly by Task Scheduler: see install-task.ps1.

  Settings live outside the script, so it can be replaced without losing them:

    %USERPROFILE%\.usageratio\config.json

      {
        "apiUrl":    "https://usageratio.snktibor.hu/api/usage",
        "apiToken":  "<the server's USAGE_API_TOKEN>",
        "machineId": "win-desktop",
        "groupId":   "Work"
      }

  Log: %USERPROFILE%\.usageratio\usageratio.log
  Exit codes: 0 sent, 1 sending failed, 2 bad usage/config, 3 token reader failed

.PARAMETER Tokens
  Send this number instead of reading it (tests the pipeline).

.PARAMETER DryRun
  Print the JSON payload, send nothing.

.PARAMETER ConfigPath
  Use another config file.
#>
[CmdletBinding()]
param(
  [long]$Tokens = -1,
  [switch]$DryRun,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ==============================================================================
#  [TODO: INSERT CODEX TOKEN READ LOGIC HERE]
# ==============================================================================
#  Replace the body of Read-CodexTokens. It must return a non-negative whole
#  number. On failure throw: nothing is sent then.
#
#  What the number means is set on the server (TOKEN_MODE in lib/config.ts):
#    delta     (default) tokens used since the previous SUCCESSFUL report
#    snapshot  this machine's running total for the current weekly cycle
#    counter   an ever-growing total; the server works out the increase
#
#  A delta reader has to remember what it already reported. Do that in
#  Save-ReaderState: it runs only after the server has stored the report,
#  so a failed upload is simply included in the next hour's number.
# ------------------------------------------------------------------------------
function Read-CodexTokens {
  throw 'The Codex token reader is not implemented yet (see the TODO at the top of this script).'
}

function Save-ReaderState {
  param([long]$ReportedTokens)
  # $ReportedTokens = the token count the server just accepted
}
# =========================== END OF TOKEN READ LOGIC ==========================

# --- Settings -----------------------------------------------------------------

$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = [Environment]::GetFolderPath('UserProfile') }
$dataDir = Join-Path $homeDir '.usageratio'
if (-not $ConfigPath) { $ConfigPath = Join-Path $dataDir 'config.json' }
$logFile = Join-Path $dataDir 'usageratio.log'

function Write-Log {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try {
    if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
    $lines = @(Get-Content -LiteralPath $logFile)
    if ($lines.Count -gt 1000) { Set-Content -LiteralPath $logFile -Value $lines[-500..-1] -Encoding UTF8 }
  } catch { }
  # Visible when run by hand; the scheduled task has no console to show it on.
  Write-Host $line
}

function Get-Setting {
  param($Config, [string]$Name, [string]$EnvName, [string]$Default = '')
  $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
  if ($fromEnv) { return $fromEnv }
  if ($Config -and $Config.PSObject.Properties[$Name] -and $Config.$Name) { return [string]$Config.$Name }
  return $Default
}

$config = $null
if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Log "ERROR: $ConfigPath is not valid JSON: $($_.Exception.Message)"
    exit 2
  }
}

# Environment variables win over the config file (handy for one-off tests).
$apiUrl = Get-Setting $config 'apiUrl' 'USAGERATIO_API_URL' 'https://usageratio.snktibor.hu/api/usage'
$apiToken = Get-Setting $config 'apiToken' 'USAGERATIO_API_TOKEN'
$machineId = Get-Setting $config 'machineId' 'USAGERATIO_MACHINE_ID' ([Environment]::MachineName)
$groupId = Get-Setting $config 'groupId' 'USAGERATIO_GROUP_ID'

if (-not $groupId -or -not $machineId) {
  Write-Log "ERROR: machineId and groupId must be set in $ConfigPath"
  exit 2
}
if (-not $DryRun -and -not $apiToken) {
  Write-Log "ERROR: apiToken is not set in $ConfigPath"
  exit 2
}

# --- Token count --------------------------------------------------------------

[long]$tokenCount = -1
if ($Tokens -ge 0) {
  $tokenCount = $Tokens
} else {
  try {
    $tokenCount = [long](Read-CodexTokens)
  } catch {
    Write-Log "ERROR: the Codex token reader failed: $($_.Exception.Message)"
    exit 3
  }
}
if ($tokenCount -lt 0) {
  Write-Log "ERROR: the token count must be a non-negative whole number, got: $tokenCount"
  exit 3
}

# --- Payload ------------------------------------------------------------------

$timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$payload = [ordered]@{
  machineId = $machineId
  groupId   = $groupId
  tokens    = $tokenCount
  timestamp = $timestamp
} | ConvertTo-Json -Compress

if ($DryRun) {
  Write-Output $payload
  exit 0
}

# --- Send ---------------------------------------------------------------------

# Windows PowerShell 5.1 on older systems does not offer TLS 1.2 by default.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# Sent as bytes: 5.1 would otherwise encode the body as Latin-1 and break accented names.
$body = [Text.Encoding]::UTF8.GetBytes($payload)
$headers = @{ Authorization = "Bearer $apiToken" }

function Send-Report {
  try {
    $response = Invoke-WebRequest -Uri $apiUrl -Method Post -Headers $headers -Body $body `
      -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 -UseBasicParsing
    return @{ Status = [int]$response.StatusCode; Text = [string]$response.Content }
  } catch {
    $status = 0
    $text = $_.Exception.Message
    # 5.1 throws WebException, 7+ throws HttpResponseException; both expose .Response.StatusCode.
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch { }
    }
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
    return @{ Status = $status; Text = $text }
  }
}

$maxAttempts = 3
$result = $null
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  $result = Send-Report
  # Retry only what can heal by itself: no connection, timeouts, throttling, server errors.
  $transient = ($result.Status -eq 0) -or ($result.Status -eq 408) -or ($result.Status -eq 429) -or ($result.Status -ge 500)
  if (-not $transient -or $attempt -eq $maxAttempts) { break }
  Start-Sleep -Seconds 5
}

if ($result.Status -eq 200 -or $result.Status -eq 201) {
  Save-ReaderState -ReportedTokens $tokenCount
  $note = ''
  if ($result.Status -eq 200) { $note = ' (already stored)' }
  Write-Log "OK: $tokenCount tokens as $machineId/$groupId$note"
  exit 0
}

$text = ([string]$result.Text -replace '\s+', ' ')
if ($text.Length -gt 300) { $text = $text.Substring(0, 300) }
if ($result.Status -eq 0) {
  Write-Log "ERROR: could not reach ${apiUrl}: $text"
} else {
  Write-Log "ERROR: server answered HTTP $($result.Status): $text"
}
exit 1
