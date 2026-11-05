@echo off
rem ============================================================================
rem  Chess Review - one-click install of the native Stockfish 19 engine
rem
rem  Double-click this file. It does the whole install with no questions:
rem    * fetches anything this copy is missing (the installer script, the helper
rem      source, the recorded checksums, and the official Stockfish 19 itself)
rem    * verifies the engine's SHA-256 against the recorded hash BEFORE installing,
rem      and refuses to install anything that does not match
rem    * installs the helper under %LOCALAPPDATA%\ChessReview (per user, no admin)
rem    * finds the extension in Brave / Chrome / Edge / Chromium / Firefox and
rem      registers the helper for it
rem    * starts the helper and Stockfish once and prints the verdict
rem
rem  Then open Chess Review and press Recheck in Settings > Engine > Build.
rem  Uninstall any time with native\uninstall.ps1 (or delete %LOCALAPPDATA%\ChessReview).
rem ============================================================================
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell was not found on this computer.
  echo.
  pause
  exit /b 1
)

rem ---- Bootstrap -------------------------------------------------------------
rem A copy of this file on its own (no native\ folder) can still install: pull the
rem installer, the helper source and the recorded checksums from the project. The
rem engine is downloaded and verified by the installer itself.
if not exist "native\install.ps1" goto :bootstrap
if not exist "native\host\ChessReviewHost.cs" goto :bootstrap
if not exist "native\engine\checksums.json" goto :bootstrap
goto :install

:bootstrap
echo This copy is missing the installer files; fetching them from the project...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }; $ProgressPreference='SilentlyContinue'; $root='%~dp0'; $base='https://raw.githubusercontent.com/aciokie/Chess-Review/main/'; foreach ($rel in @('native/install.ps1','native/host/ChessReviewHost.cs','native/host/ChessReviewHost.exe','native/host/checksums.json','native/engine/checksums.json')) { $dest=Join-Path $root ($rel -replace '/','\'); $dir=Split-Path -Parent $dest; if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; Write-Host ('  ' + $rel); Invoke-WebRequest -Uri ($base + $rel) -OutFile $dest -UseBasicParsing }"
if errorlevel 1 (
  echo.
  echo Could not fetch the installer files. Check your internet connection, or download
  echo the full Chess Review folder from https://github.com/aciokie/Chess-Review and run
  echo this file from there.
  echo.
  pause
  exit /b 1
)
echo.

:install
echo Installing the Chess Review native engine (Stockfish 19)...
echo.
rem Any arguments are passed straight through, e.g.:
rem   "Install Native Engine.bat" -Force
rem   "Install Native Engine.bat" -ExtensionId abcdefghijklmnopabcdefghijklmnop
powershell -NoProfile -ExecutionPolicy Bypass -File "native\install.ps1" %*
echo.
if errorlevel 1 (
  echo Installation FAILED. Read the messages above.
) else (
  echo Done. Now open Chess Review and press Recheck in Settings ^> Engine ^> Build.
)
echo.
pause
endlocal
