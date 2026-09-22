<#
.SYNOPSIS
  Shared usageratio reporter core for Windows.

.DESCRIPTION
  Works on Windows PowerShell 5.1 and PowerShell 7+. Requires Node.js/npx;
  npx downloads or reuses ccusage. No jq or other JSON utility is needed.
  Use ..\auto\report-usage.ps1 or ..\manual\report-usage.ps1 instead of calling this file directly.

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

.PARAMETER Providers
  Send this provider JSON instead of reading ccusage (tests the pipeline).

.PARAMETER Tokens
  Compatibility shortcut for -Providers '{"deepseek":N}'.

.PARAMETER DryRun
  Print the JSON payload, send nothing.

.PARAMETER ConfigPath
  Use another config file.
#>
[CmdletBinding()]
param(
  [long]$Tokens = -1,
  [string]$Providers,
  [switch]$DryRun,
  [string]$ConfigPath,
  [ValidateSet('Silent', 'Manual')][string]$OutputMode = 'Silent'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$parserPath = Join-Path $PSScriptRoot 'ccusage-providers.cjs'

function Read-ProviderTokens {
  param([string]$SinceDate, [string]$TimeZone, [string]$FallbackProviders)
  if (-not (Test-Path -LiteralPath $parserPath)) {
    throw "$parserPath is missing; install it next to this script."
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
  if (-not $node -or -not $npx) { throw 'Node.js/npx was not found in PATH.' }

  $errorFile = Join-Path ([IO.Path]::GetTempPath()) ("usageratio-ccusage-{0}.log" -f [Guid]::NewGuid())
  try {
    $ccusageArgs = @('--yes', 'ccusage@latest', 'daily', '--json', '--by-agent', '--breakdown', '--no-cost', '--since', $SinceDate, '--timezone', $TimeZone)
    $raw = & $npx.Source @ccusageArgs 2> $errorFile | Out-String
    if ($LASTEXITCODE -ne 0) {
      $details = if (Test-Path -LiteralPath $errorFile) { Get-Content -LiteralPath $errorFile -Raw } else { '' }
      throw "ccusage exited with code $LASTEXITCODE. $details"
    }
    $providersJson = $raw | & $node.Source $parserPath parse $FallbackProviders 2>> $errorFile
    if ($LASTEXITCODE -ne 0 -or -not $providersJson) {
      $details = if (Test-Path -LiteralPath $errorFile) { Get-Content -LiteralPath $errorFile -Raw } else { '' }
      throw "The ccusage JSON could not be converted. $details"
    }
    return [string]$providersJson
  } finally {
    Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
  }
}

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
  if ($OutputMode -eq 'Manual' -and $Message.StartsWith('ERROR:')) {
    Write-Host "$([char]0x274c) Sync failed: $($Message.Substring(6).Trim())" -ForegroundColor Red
  }
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
$headers = @{ Authorization = "Bearer $apiToken" }

# Windows PowerShell 5.1 on older systems does not offer TLS 1.2 by default.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

if (-not $groupId -or -not $machineId) {
  Write-Log "ERROR: machineId and groupId must be set in $ConfigPath"
  exit 2
}
if (-not $DryRun -and -not $apiToken) {
  Write-Log "ERROR: apiToken is not set in $ConfigPath"
  exit 2
}
if (-not (Test-Path -LiteralPath $parserPath)) {
  Write-Log "ERROR: $parserPath is missing; install it next to this script"
  exit 2
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Log 'ERROR: Node.js was not found (it is required by ccusage and the JSON parser)'
  exit 2
}

# --- Provider snapshots -------------------------------------------------------

$providersJson = $null
if ($Providers) {
  try {
    $providersJson = $Providers | & $nodeCommand.Source $parserPath validate
    if ($LASTEXITCODE -ne 0) { throw 'Invalid provider JSON.' }
  } catch {
    Write-Log "ERROR: -Providers is invalid: $($_.Exception.Message)"
    exit 3
  }
} elseif ($Tokens -ge 0) {
  if ($Tokens -gt 9007199254740991) {
    Write-Log "ERROR: -Tokens exceeds JSON's safe integer range: $Tokens"
    exit 3
  }
  $providersJson = @{ deepseek = $Tokens } | ConvertTo-Json -Compress
} else {
  try {
    if (-not $apiToken) { throw 'apiToken is required to read the current cycle before running ccusage.' }
    $cycleResponse = Invoke-RestMethod -Uri $apiUrl -Method Get -Headers $headers -TimeoutSec 30 -UseBasicParsing
    $sinceDate = [string]$cycleResponse.cycle.sinceDate
    $timeZone = [string]$cycleResponse.cycle.timeZone
    $fallbackProviders = @($cycleResponse.providers) -join ','
    if (-not $sinceDate -or -not $timeZone) { throw 'The server did not return a complete cycle.' }
    $providersJson = Read-ProviderTokens -SinceDate $sinceDate -TimeZone $timeZone -FallbackProviders $fallbackProviders
  } catch {
    Write-Log "ERROR: ccusage could not be read: $($_.Exception.Message)"
    exit 3
  }
}

# --- Payload ------------------------------------------------------------------

$timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$providerMap = $providersJson | ConvertFrom-Json
$payload = [ordered]@{
  machineId = $machineId
  groupId   = $groupId
  timestamp = $timestamp
  providers = $providerMap
} | ConvertTo-Json -Compress

if ($DryRun) {
  Write-Output $payload
  exit 0
}

# --- Send ---------------------------------------------------------------------

# Sent as bytes: 5.1 would otherwise encode the body as Latin-1 and break accented names.
$body = [Text.Encoding]::UTF8.GetBytes($payload)
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
  $note = ''
  if ($result.Status -eq 200) { $note = ' (already stored)' }
  Write-Log "OK: $providersJson as $machineId/$groupId$note"
  if ($OutputMode -eq 'Manual') {
    $providerCount = @($providerMap.PSObject.Properties).Count
    Write-Host "$([char]0x2705) Sync successful: $providerCount providers sent.$note" -ForegroundColor Green
  }
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
