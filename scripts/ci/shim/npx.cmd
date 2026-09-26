@echo off
rem Fake npx for CI/local Pester runs (Windows). USAGERATIO_CCUSAGE=global
rem makes report-usage-core.ps1 call ccusage.cmd directly and never fall back
rem to npx; this always fails so that fallback path is never silently used.
echo npx shim: should not be called when USAGERATIO_CCUSAGE=global 1>&2
exit /b 1
