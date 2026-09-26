$coreScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'shared\report-usage-core.ps1'
if (-not (Test-Path -LiteralPath $coreScript)) { exit 2 }

# This wrapper's own schedule (install-task.ps1 registers it hourly by default);
# the core script reports it so the dashboard's machine health can use it instead
# of the server's default interval. An already-set USAGERATIO_INTERVAL_MINUTES wins.
if (-not $env:USAGERATIO_INTERVAL_MINUTES) { $env:USAGERATIO_INTERVAL_MINUTES = '60' }

& $coreScript -OutputMode Silent @args
exit $LASTEXITCODE
