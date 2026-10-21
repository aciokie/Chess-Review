@echo off
rem ============================================================================
rem  Chess Review - one-click install of the native Stockfish 19 engine
rem
rem  Double-click this file. It runs the installer with everything defaulted:
rem    * the official Stockfish 19 build bundled in native\engine (SHA-256 verified
rem      against native\engine\checksums.json and hash-pinned automatically)
rem    * your unpacked extension id is found in Brave / Chrome / Edge automatically
rem    * a self-test starts the helper and Stockfish once and prints the verdict
rem
rem  No commands to type, no administrator rights. Uninstall any time with
rem  native\uninstall.ps1 (or delete %LOCALAPPDATA%\ChessReview).
rem ============================================================================
setlocal
cd /d "%~dp0"
where powershell >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell was not found on this computer.
  pause
  exit /b 1
)
echo Installing the Chess Review native engine (Stockfish 19)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "native\install.ps1"
echo.
if errorlevel 1 (
  echo Installation FAILED. Read the messages above.
) else (
  echo Done. Now open Chess Review, press Recheck in Settings ^> Engine ^> Build.
)
echo.
pause
endlocal
