$coreScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'shared\report-usage-core.ps1'
if (-not (Test-Path -LiteralPath $coreScript)) { exit 2 }

& $coreScript -OutputMode Silent @args
exit $LASTEXITCODE
