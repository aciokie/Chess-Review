@echo off
rem ============================================================================
rem  Chess Review - one-click update (no git needed)
rem
rem  Double-click this file. It downloads only the files that changed on GitHub
rem  into this folder. Afterwards open chrome://extensions and press the reload
rem  button on Chess Review.
rem ============================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-extension.ps1"
echo.
pause
