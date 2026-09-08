@echo off
setlocal
set "PACKAGED=%~dp0release-final\KINO Print\KINO Print.exe"
if exist "%PACKAGED%" (
  start "KINO Print" "%PACKAGED%"
  exit /b 0
)
set "ELECTRON=%~dp0..\..\node_modules\electron\dist\electron.exe"
if exist "%ELECTRON%" (
  start "KINO Print" "%ELECTRON%" "%~dp0"
  exit /b 0
)
echo KINO Print is not built. Run: corepack npm run dist:win -w @kino/print
pause
exit /b 1
