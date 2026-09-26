@echo off
rem Fake ccusage for CI/local Pester runs (Windows). Prints fixture JSON for
rem the `daily` and `blocks` subcommands report-usage-core.ps1 calls; the
rem fixtures directory comes from USAGERATIO_CI_FIXTURES so this file does
rem not need to know where it, or the repository, live on disk.
setlocal
if "%USAGERATIO_CI_FIXTURES%"=="" (
  echo ccusage shim: USAGERATIO_CI_FIXTURES is not set 1>&2
  exit /b 1
)
if "%~1"=="daily" (
  type "%USAGERATIO_CI_FIXTURES%\daily.json"
  exit /b 0
)
if "%~1"=="blocks" (
  type "%USAGERATIO_CI_FIXTURES%\blocks.json"
  exit /b 0
)
echo ccusage shim: unknown subcommand "%~1" 1>&2
exit /b 1
