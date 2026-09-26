<#
.SYNOPSIS
  usageratio client installer for Windows.

.DESCRIPTION
  Run it from the folder of the setup package, wherever that folder is:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

  or double-click install.cmd next to it. Next to this file: config.json,
  report-usage-core.ps1, ccusage-providers.cjs and exactly one of
  report-usage-auto.ps1 / report-usage-manual.ps1, which decides the mode:

    auto    an hourly, invisible scheduled task reports silently. Registering
            it needs administrator rights once: the installer asks for them.
            install-task.ps1 belongs to this mode's package.
    manual  the "Sync tokens" desktop shortcut reports on demand

  The reporter is copied to %USERPROFILE%\.usageratio, config.json is written
  there with the API token asked for here, and a first report is sent. Running
  it again updates the scripts and keeps the machine id already in use.

  The token prompt is skipped when $env:USAGERATIO_API_TOKEN is set.
  Works on Windows PowerShell 5.1 and PowerShell 7+.
  Exit codes: 0 installed, 1 installation failed, 2 incomplete package

.PARAMETER Relaunched
  Set by the installer itself when it restarts with administrator rights.
#>
[CmdletBinding()]
param([switch]$Relaunched)

# Read inside functions below; a script-level copy keeps that explicit.
$script:WasRelaunched = [bool]$Relaunched

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$sourceDir = $PSScriptRoot
$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = [Environment]::GetFolderPath('UserProfile') }
$root = Join-Path $homeDir '.usageratio'
$configPath = Join-Path $root 'config.json'
$logFile = Join-Path $root 'usageratio.log'
# The console host that runs this script starts the reporter and the elevated
# restart; from ISE or an editor's host, Windows PowerShell stands in.
$hostPath = (Get-Process -Id $PID).Path
if (-not $hostPath -or [IO.Path]::GetFileNameWithoutExtension($hostPath) -notin @('powershell', 'pwsh')) {
  $hostPath = 'powershell.exe'
}

# The elevated window closes when the script ends: keep it open for the summary.
function Exit-Install {
  param([int]$Code)
  if ($script:WasRelaunched) { [void](Read-Host 'Press Enter to close this window') }
  exit $Code
}

function Exit-InstallError {
  param([string]$Message, [int]$Code = 1)
  Write-Host "$([char]0x274c) $Message" -ForegroundColor Red
  Exit-Install $Code
}

function Write-Caution {
  param([string]$Message)
  Write-Host "$([char]0x26a0) $Message" -ForegroundColor Yellow
}

# --- Package ------------------------------------------------------------------

$hasAuto = Test-Path -LiteralPath (Join-Path $sourceDir 'report-usage-auto.ps1')
$hasManual = Test-Path -LiteralPath (Join-Path $sourceDir 'report-usage-manual.ps1')
if ($hasAuto -and $hasManual) {
  Exit-InstallError "Both report-usage-auto.ps1 and report-usage-manual.ps1 are in $sourceDir; keep the one you want." 2
}
if (-not ($hasAuto -or $hasManual)) {
  Exit-InstallError "report-usage-auto.ps1 or report-usage-manual.ps1 is missing from $sourceDir." 2
}
$mode = 'manual'
if ($hasAuto) { $mode = 'auto' }

$required = @('config.json', 'report-usage-core.ps1', 'ccusage-providers.cjs')
if ($mode -eq 'auto') { $required += 'install-task.ps1' }
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $file))) {
    Exit-InstallError "$file is missing from $sourceDir. Every package file belongs in one folder, next to install.ps1." 2
  }
}

# The S4U task that runs without a visible window can only be registered elevated.
if ($mode -eq 'auto') {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Host 'The hourly task runs invisibly only when it is registered with administrator rights.'
    Write-Host 'Confirm the Windows prompt; the installation continues in a new window.'
    try {
      Start-Process -FilePath $hostPath -Verb RunAs `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Relaunched"
    } catch {
      Exit-InstallError 'Administrator rights were not granted, so nothing was installed. Run the installer again and confirm the prompt.'
    }
    exit 0
  }
}

try {
  $package = Get-Content -LiteralPath (Join-Path $sourceDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Exit-InstallError "config.json is not valid JSON: $($_.Exception.Message)" 2
}
$apiUrl = ([string]$package.apiUrl).Trim()
$groupId = ([string]$package.groupId).Trim()
$machineId = ([string]$package.machineId).Trim()
if (-not $groupId) { Exit-InstallError 'groupId is empty in config.json.' 2 }
if ($apiUrl -notmatch '^https?://') { Exit-InstallError "apiUrl in config.json must be the server's /api/usage address." 2 }

$existing = $null
if (Test-Path -LiteralPath $configPath) {
  try { $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $existing = $null }
}
$existingToken = ''
$existingMachineId = ''
if ($existing) {
  if ($existing.PSObject.Properties['apiToken']) { $existingToken = ([string]$existing.apiToken).Trim() }
  if ($existing.PSObject.Properties['machineId']) { $existingMachineId = ([string]$existing.machineId).Trim() }
}

# An empty machineId keeps the id this machine already reports under, so a
# reinstall never splits its history; a first install takes the computer's name.
if (-not $machineId) { $machineId = $existingMachineId }
if (-not $machineId) { $machineId = [Environment]::MachineName }

# --- Requirements -------------------------------------------------------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Exit-InstallError 'Node.js was not found. Install it (https://nodejs.org), then run the installer again: ccusage and the reporter both need it.'
}

# Windows PowerShell 5.1 on older systems does not offer TLS 1.2 by default.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { Write-Verbose "Older systems may not know TLS 1.2 by this name; the request will tell. ($($_.Exception.Message))" }

# --- API token ----------------------------------------------------------------

# The status the server answers the cycle lookup with: 200 accepted, 401 rejected, 0 no answer.
function Test-Token {
  param([string]$Token)
  try {
    $response = Invoke-WebRequest -Uri $apiUrl -Method Get -Headers @{ Authorization = "Bearer $Token" } `
      -TimeoutSec 30 -UseBasicParsing
    return [int]$response.StatusCode
  } catch {
    # 5.1 throws WebException, 7+ throws HttpResponseException; both expose .Response.StatusCode.
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
      try { return [int]$_.Exception.Response.StatusCode } catch { Write-Verbose "Not every error carries a status code; 0 stands for no answer. ($($_.Exception.Message))" }
    }
    return 0
  }
}

function Read-Token {
  $prompt = 'USAGE_API_TOKEN'
  if ($existingToken) { $prompt = 'USAGE_API_TOKEN (Enter keeps the saved one)' }
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $typed = (New-Object System.Net.NetworkCredential('', $secure)).Password -replace '\s', ''
  if ($typed) { return $typed }
  return $existingToken
}

$token = ([string]$env:USAGERATIO_API_TOKEN) -replace '\s', ''
if ($token) {
  $status = Test-Token $token
  if ($status -eq 401) { Exit-InstallError 'The server rejected $env:USAGERATIO_API_TOKEN (HTTP 401).' }
  if ($status -ne 200) { Write-Caution "The token could not be checked (HTTP $status from $apiUrl); the first report will tell." }
} else {
  Write-Host "The API token is the server's USAGE_API_TOKEN, the same on every machine. Typing is hidden."
  $attempt = 0
  while ($true) {
    $attempt++
    $token = Read-Token
    $status = 401
    if ($token) {
      $status = Test-Token $token
    } else {
      Write-Caution 'The token cannot be empty.'
    }
    if ($status -eq 200) {
      Write-Host "$([char]0x2705) The server accepted the token." -ForegroundColor Green
      break
    }
    if ($status -ne 401) {
      $why = "HTTP $status from $apiUrl"
      if ($status -eq 0) { $why = "$apiUrl did not answer" }
      Write-Caution "The token could not be checked ($why). It is saved anyway; the first report will tell."
      break
    }
    if ($attempt -ge 3) { Exit-InstallError 'No valid token after three tries; nothing was installed.' }
    if ($token) { Write-Caution 'The server rejected this token (HTTP 401). Try again.' }
  }
}

# --- Install ------------------------------------------------------------------

# Written as fresh files: nothing downloaded is carried over (no "blocked" mark),
# and a byte order mark some editors add is dropped from the Node script, whose
# first line Node would otherwise refuse.
function Copy-PackageFile {
  param([string]$Name, [string]$Folder, [string]$Target, [switch]$StripBom)
  $from = Join-Path $sourceDir $Name
  $to = Join-Path (Join-Path $root $Folder) $Target
  $bytes = [IO.File]::ReadAllBytes($from)
  if ($StripBom -and $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = [byte[]]($bytes | Select-Object -Skip 3)
  }
  [IO.File]::WriteAllBytes($to, $bytes)
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $root $mode), (Join-Path $root 'shared') | Out-Null
  Copy-PackageFile "report-usage-$mode.ps1" $mode 'report-usage.ps1'
  Copy-PackageFile 'report-usage-core.ps1' 'shared' 'report-usage-core.ps1'
  Copy-PackageFile 'ccusage-providers.cjs' 'shared' 'ccusage-providers.cjs' -StripBom
  if ($mode -eq 'auto') { Copy-PackageFile 'install-task.ps1' 'auto' 'install-task.ps1' }

  $settings = [ordered]@{
    apiUrl    = $apiUrl
    apiToken  = $token
    machineId = $machineId
    groupId   = $groupId
  }
  [IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
} catch {
  Exit-InstallError "The files could not be installed: $($_.Exception.Message)"
}

# --- First report -------------------------------------------------------------

Write-Host "Sending a first report as $machineId in group $groupId (the first run may download ccusage)..."
& $hostPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path (Join-Path $root $mode) 'report-usage.ps1')
$reportCode = $LASTEXITCODE
if ($reportCode -eq 0) {
  if ($mode -eq 'auto') { Write-Host "$([char]0x2705) First report sent." -ForegroundColor Green }
} elseif ($mode -eq 'auto') {
  $last = ''
  if (Test-Path -LiteralPath $logFile) { $last = Get-Content -LiteralPath $logFile -Tail 1 -Encoding UTF8 }
  Write-Caution "The first report failed (exit $reportCode): $last"
  Write-Caution 'The hourly task is set up anyway and tries again every hour.'
}

# --- Schedule or shortcut -----------------------------------------------------

try {
  if ($mode -eq 'auto') {
    & (Join-Path (Join-Path $root 'auto') 'install-task.ps1')
  } else {
    $launcher = Join-Path (Join-Path $root 'manual') 'sync-tokens.cmd'
    $lines = @(
      '@echo off',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.usageratio\manual\report-usage.ps1"',
      'echo.',
      'pause'
    )
    [IO.File]::WriteAllText($launcher, (($lines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sync tokens.lnk'))
    $shortcut.TargetPath = $launcher
    $shortcut.WorkingDirectory = Join-Path $root 'manual'
    $shortcut.Description = 'Send AI token usage to usageratio'
    $shortcut.Save()
  }
} catch {
  Exit-InstallError "The files are in place, but the $mode setup failed: $($_.Exception.Message)"
}

# --- Summary ------------------------------------------------------------------

Write-Host ''
Write-Host "$([char]0x2705) usageratio is installed ($mode) as $machineId in group $groupId." -ForegroundColor Green
Write-Host "   Scripts:  $root\$mode, $root\shared"
Write-Host "   Settings: $configPath"
Write-Host "   Log:      $logFile"
if ($mode -eq 'auto') {
  Write-Host "   It reports every hour through the scheduled task 'usageratio-report'."
} else {
  Write-Host "   Double-click 'Sync tokens' on the desktop to report."
}
Write-Host "   $sourceDir is no longer needed; you can delete it."
Exit-Install 0
