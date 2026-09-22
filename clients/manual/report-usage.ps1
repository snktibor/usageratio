$coreScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'shared\report-usage-core.ps1'
if (-not (Test-Path -LiteralPath $coreScript)) {
  Write-Host "$([char]0x274c) Sync failed: $coreScript is missing." -ForegroundColor Red
  exit 2
}

& $coreScript -OutputMode Manual @args
exit $LASTEXITCODE
