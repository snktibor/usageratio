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
        "apiUrl":    "https://usageratio.example.com/api/usage",
        "apiToken":  "<the server's USAGE_API_TOKEN>",
        "machineId": "win-desktop",
        "groupId":   "Work"
      }

  Log: %USERPROFILE%\.usageratio\usageratio.log (USAGERATIO_LOG_FILE overrides it)
  Exit codes: 0 sent, 1 sending failed, 2 bad usage/config, 3 token reader failed

.PARAMETER Providers
  Send this provider JSON instead of reading ccusage (tests the pipeline).

.PARAMETER Tokens
  One provider's total as provider=count, e.g. -Tokens claude=1234 (use -Providers for several).

.PARAMETER DryRun
  Print the JSON payload, send nothing.

.PARAMETER ConfigPath
  Use another config file.
#>
[CmdletBinding()]
param(
  [string]$Tokens = '',
  [string]$Providers,
  [switch]$DryRun,
  [string]$ConfigPath,
  [ValidateSet('Silent', 'Manual')][string]$OutputMode = 'Silent'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$parserPath = Join-Path $PSScriptRoot 'ccusage-providers.cjs'
# The ccusage version npx runs; keep equal to lib/setup.ts CCUSAGE_VERSION (tests/setup.test.ts
# checks it). USAGERATIO_CCUSAGE_VERSION overrides it; "latest" is an explicit opt-in.
$ccusageVersion = $env:USAGERATIO_CCUSAGE_VERSION
if (-not $ccusageVersion) { $ccusageVersion = '20.0.24' }

# The ccusage command(s) to try, in order, for USAGERATIO_CCUSAGE: "global" only the
# installed command, "npx" only the current package through npx, anything else (the
# default) the installed one first with npx as its fallback. Mirrors run_ccusage in
# report-usage-core.sh. Throws when nothing the mode allows is on PATH.
function Get-CcusageAttempts {
  $mode = $env:USAGERATIO_CCUSAGE
  $global = $null
  if ($mode -ne 'npx') {
    $global = Get-Command ccusage.cmd -ErrorAction SilentlyContinue
    if (-not $global) { $global = Get-Command ccusage -ErrorAction SilentlyContinue }
  }
  $npx = $null
  if ($mode -ne 'global') {
    $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
  }
  if ($mode -eq 'global' -and -not $global) { throw 'Node.js/ccusage was not found in PATH.' }
  if ($mode -eq 'npx' -and -not $npx) { throw 'Node.js/npx was not found in PATH.' }
  if ($mode -ne 'global' -and $mode -ne 'npx' -and -not $global -and -not $npx) {
    throw 'Neither ccusage nor npx was found in PATH.'
  }
  # Built as one array and returned through Write-Output -NoEnumerate: a bare `return` of a
  # single-item array unwraps it back to a lone object, and $attempts.Count would then count
  # a hashtable's keys instead of the number of attempts.
  $attempts = @()
  if ($global) { $attempts += @{ Exe = $global.Source; Prefix = @() } }
  if ($npx) { $attempts += @{ Exe = $npx.Source; Prefix = @('--yes', "ccusage@$ccusageVersion") } }
  Write-Output $attempts -NoEnumerate
}

# Runs ccusage with the given arguments, trying every attempt in order until one exits 0;
# returns its stdout, or $null when every attempt failed. $ErrorFile (when given) collects
# every attempt's stderr, appended; without it stderr is discarded (an optional read).
function Invoke-Ccusage {
  param([array]$Attempts, [string[]]$CcusageArgs, [string]$ErrorFile = '')
  foreach ($attempt in $Attempts) {
    $fullArgs = $attempt.Prefix + $CcusageArgs
    if ($ErrorFile) {
      $raw = & $attempt.Exe @fullArgs 2>> $ErrorFile | Out-String
    } else {
      $raw = & $attempt.Exe @fullArgs 2> $null | Out-String
    }
    if ($LASTEXITCODE -eq 0) { return $raw }
  }
  return $null
}

function Read-ProviderTokens {
  param([string]$SinceDate, [string]$TimeZone, [string]$FallbackProviders, [string]$CycleStart)
  if (-not (Test-Path -LiteralPath $parserPath)) {
    throw "$parserPath is missing; install it next to this script."
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js was not found in PATH.' }
  $attempts = Get-CcusageAttempts

  $errorFile = Join-Path ([IO.Path]::GetTempPath()) ("usageratio-ccusage-{0}.log" -f [Guid]::NewGuid())
  $blocksFile = Join-Path ([IO.Path]::GetTempPath()) ("usageratio-blocks-{0}.json" -f [Guid]::NewGuid())
  # Windows PowerShell 5.1 turns every redirected stderr line of a native command
  # (an npm notice, a Node deprecation warning) into a terminating error under
  # 'Stop'. Relaxed for this function only: the exit codes below decide instead.
  $ErrorActionPreference = 'Continue'
  try {
    # Claude Code's usage by clock hour, read before the daily report so the hours
    # never run ahead of the days. Optional: without it the days are sent whole.
    $blocksArgs = @('blocks', '--json', '--offline', '--session-length', '1', '--since', ($SinceDate -replace '-', ''), '--timezone', $TimeZone)
    try {
      $blocksRaw = Invoke-Ccusage -Attempts $attempts -CcusageArgs $blocksArgs
      if ($blocksRaw) { [IO.File]::WriteAllText($blocksFile, $blocksRaw) }
    } catch { }
    $hourlyArgs = @()
    if ($CycleStart -and (Test-Path -LiteralPath $blocksFile)) { $hourlyArgs = @($blocksFile, $CycleStart, $TimeZone) }
    # Windows PowerShell 5.1 drops an empty argument, which would shift the ones after it.
    if (-not $FallbackProviders) { $FallbackProviders = ',' }

    $ccusageArgs = @('daily', '--json', '--by-agent', '--breakdown', '--no-cost', '--since', $SinceDate, '--timezone', $TimeZone)
    $raw = Invoke-Ccusage -Attempts $attempts -CcusageArgs $ccusageArgs -ErrorFile $errorFile
    if (-not $raw) {
      $details = if (Test-Path -LiteralPath $errorFile) { Get-Content -LiteralPath $errorFile -Raw } else { '' }
      throw "ccusage could not be run. $details"
    }
    $providersJson = $raw | & $node.Source $parserPath parse $FallbackProviders @hourlyArgs 2>> $errorFile
    if ($LASTEXITCODE -ne 0 -or -not $providersJson) {
      $details = if (Test-Path -LiteralPath $errorFile) { Get-Content -LiteralPath $errorFile -Raw } else { '' }
      throw "The ccusage JSON could not be converted. $details"
    }
    # The splits by model and by day are optional: without them the report still goes out.
    try {
      $splitJson = $raw | & $node.Source $parserPath parse-models $FallbackProviders @hourlyArgs 2> $null
      if ($LASTEXITCODE -eq 0 -and $splitJson) { $script:modelsJson = [string]$splitJson }
    } catch { }
    try {
      $daysSplitJson = $raw | & $node.Source $parserPath parse-days $FallbackProviders @hourlyArgs 2> $null
      if ($LASTEXITCODE -eq 0 -and $daysSplitJson) { $script:daysJson = [string]$daysSplitJson }
    } catch { }
    return [string]$providersJson
  } finally {
    Remove-Item -LiteralPath $errorFile, $blocksFile -Force -ErrorAction SilentlyContinue
  }
}

# --- Settings -----------------------------------------------------------------

$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = [Environment]::GetFolderPath('UserProfile') }
$dataDir = Join-Path $homeDir '.usageratio'
if (-not $ConfigPath) { $ConfigPath = Join-Path $dataDir 'config.json' }
$logFile = [Environment]::GetEnvironmentVariable('USAGERATIO_LOG_FILE')
if (-not $logFile) { $logFile = Join-Path $dataDir 'usageratio.log' }
$logDir = Split-Path -Parent $logFile

function Write-Log {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try {
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
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
$apiUrl = Get-Setting $config 'apiUrl' 'USAGERATIO_API_URL'
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
# Each provider's split by model, and the snapshot's split by day, as JSON; only ccusage readings have them.
$modelsJson = $null
$daysJson = $null
if ($Providers) {
  try {
    $providersJson = $Providers | & $nodeCommand.Source $parserPath validate
    if ($LASTEXITCODE -ne 0) { throw 'Invalid provider JSON.' }
  } catch {
    Write-Log "ERROR: -Providers is invalid: $($_.Exception.Message)"
    exit 3
  }
} elseif ($Tokens -ne '') {
  if ($Tokens -notmatch '^([A-Za-z0-9._-]+)=(\d+)$') {
    Write-Log "ERROR: -Tokens takes provider=count, e.g. -Tokens claude=1234 (got: '$Tokens')"
    exit 3
  }
  $tokensProvider = $Matches[1]
  $tokensCount = [decimal]$Matches[2]
  if ($tokensCount -gt 9007199254740991) {
    Write-Log "ERROR: -Tokens exceeds JSON's safe integer range: $tokensCount"
    exit 3
  }
  $providersJson = @{ $tokensProvider = [long]$tokensCount } | ConvertTo-Json -Compress
} else {
  try {
    if (-not $apiToken) { throw 'apiToken is required to read the current cycle before running ccusage.' }
    $cycleResponse = Invoke-RestMethod -Uri $apiUrl -Method Get -Headers $headers -TimeoutSec 30 -UseBasicParsing
    $sinceDate = [string]$cycleResponse.cycle.sinceDate
    $timeZone = [string]$cycleResponse.cycle.timeZone
    $fallbackProviders = @($cycleResponse.providers) -join ','
    if (-not $sinceDate -or -not $timeZone) { throw 'The server did not return a complete cycle.' }
    # PowerShell 7 turns ISO date strings of a JSON response into DateTime values; 5.1 keeps the string.
    $cycleStart = $cycleResponse.cycle.start
    if ($cycleStart -is [DateTime]) {
      $cycleStart = $cycleStart.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    }
    $providersJson = Read-ProviderTokens -SinceDate $sinceDate -TimeZone $timeZone -FallbackProviders $fallbackProviders -CycleStart ([string]$cycleStart)
  } catch {
    Write-Log "ERROR: ccusage could not be read: $($_.Exception.Message)"
    exit 3
  }
}

# --- Payload ------------------------------------------------------------------

$timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$providerMap = $providersJson | ConvertFrom-Json
$report = [ordered]@{
  machineId = $machineId
  groupId   = $groupId
  timestamp = $timestamp
  providers = $providerMap
}
if ($modelsJson -and $modelsJson.Trim() -ne '{}') {
  try { $report.models = $modelsJson | ConvertFrom-Json } catch { }
}
if ($daysJson -and $daysJson.Trim() -ne '{}') {
  try { $report.days = $daysJson | ConvertFrom-Json } catch { }
}
# The report's own mode/interval (lib/validation.ts ReportMode): "manual" for
# -OutputMode Manual (clients/manual/report-usage.ps1, and the one-shot report),
# "auto" otherwise (clients/auto/report-usage.ps1, which sets
# USAGERATIO_INTERVAL_MINUTES to match its scheduled task). Health on the
# dashboard treats a manual machine differently: it is never "late", since it
# has no schedule to miss. "auto" (the server's default when absent) is left out.
if ($OutputMode -eq 'Manual') {
  $report.mode = 'manual'
} else {
  $intervalMinutes = 0
  if ([int]::TryParse($env:USAGERATIO_INTERVAL_MINUTES, [ref]$intervalMinutes) -and $intervalMinutes -ge 5 -and $intervalMinutes -le 1440) {
    $report.intervalMinutes = $intervalMinutes
  }
}
# The split by day and hour nests six levels deep; ConvertTo-Json stops at two by default.
$payload = $report | ConvertTo-Json -Compress -Depth 8

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
