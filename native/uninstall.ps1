# native/uninstall.ps1 — removes exactly what native/install.ps1 created, and nothing else.
#
#   powershell -ExecutionPolicy Bypass -File native\uninstall.ps1
#
# Deletes:
#   * the four HKCU NativeMessagingHosts registrations for com.chessreview.native_engine
#     (Chrome / Chromium / Brave / Edge, plus Firefox when present)
#   * %LOCALAPPDATA%\ChessReview\native-host (helper exe, manifests, config, logs)
# The parent %LOCALAPPDATA%\ChessReview folder is removed only when left empty.
# No other registry values, files, or settings are read, modified or deleted.

[CmdletBinding()]
param(
  # Keep the installed files (and your config.json); only unregister the helper.
  [switch]$KeepFiles
)

$ErrorActionPreference = "Continue"
$Host_ = "com.chessreview.native_engine"
$InstallDir = Join-Path $env:LOCALAPPDATA "ChessReview\native-host"

Write-Host "== Chess Review native engine helper: uninstall =="

$roots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\Mozilla\NativeMessagingHosts"
)
foreach ($root in $roots) {
  $key = Join-Path $root $Host_
  if (Test-Path -LiteralPath $key) {
    # Only remove it if it points at our install; a key for a different install is not ours.
    $value = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue)."(default)"
    if ([String]::IsNullOrEmpty($value) -or $value -like "$env:LOCALAPPDATA\ChessReview\*") {
      Remove-Item -LiteralPath $key -Force
      Write-Host "Unregistered $key"
    } else {
      Write-Host "Left $key alone (it points somewhere else: $value)"
    }
  }
}

if (-not $KeepFiles) {
  if (Test-Path -LiteralPath $InstallDir) {
    # Stop exactly our own helper (matched by its installed path, never by name) so the files can go.
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -like "$InstallDir\*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 400
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Host "Removed $InstallDir"
  }
  $parent = Split-Path -Parent $InstallDir
  if (Test-Path -LiteralPath $parent) {
    if (-not (Get-ChildItem -LiteralPath $parent -Force)) {
      Remove-Item -LiteralPath $parent -Force
      Write-Host "Removed empty folder $parent"
    }
  }
}

Write-Host "Done. The extension keeps working with its bundled engines."
