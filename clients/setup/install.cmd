@echo off
rem usageratio setup: double-click this in the unpacked package folder.
if not exist "%~dp0install.ps1" (
  echo install.ps1 was not found next to install.cmd.
  echo Unpack the whole ZIP first ^(right click, Extract All^), then start install.cmd from that folder.
  echo.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
