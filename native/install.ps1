# native/install.ps1 — per-user install of the Chess Review native engine helper.
#
# What it does (no administrator rights needed, everything under HKCU + %LOCALAPPDATA%):
#   1. Compiles native/host/ChessReviewHost.cs with the csc.exe that ships with Windows
#      (.NET Framework 4.x - no SDK, no NuGet, no downloads).
#   2. Writes config.json (engine path, threads, hash, watchdog) next to the helper exe.
#   3. Writes the Native Messaging host manifest and registers it for Chrome / Chromium /
#      Brave / Edge (and optionally Firefox) under HKEY_CURRENT_USER.
#   4. Never touches anything it did not create - see native/uninstall.ps1.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File native\install.ps1 -EnginePath "C:\Tools\Stockfish\stockfish-windows-x86-64-avx2.exe"
#   # extra extension ids (e.g. your unpacked dev id) and other options:
#   powershell -ExecutionPolicy Bypass -File native\install.ps1 -EnginePath "..." -ExtensionId "abcd...", "wxyz..."
#
# After installing, reload the extension and press "Recheck" in Settings > Engine > Build.

[CmdletBinding()]
param(
  # Absolute path to a genuine Stockfish 19 Windows executable. Required on a first install; a
  # re-install may omit it to keep the existing configuration.
  [string]$EnginePath = "",
  # Optional external NNUE network, for builds that do not embed one.
  [string]$EvalFile = "",
  # UCI Threads for the engine. Keep at 1 - the extension already parallelizes positions itself.
  [int]$Threads = 1,
  # UCI Hash in MB.
  [int]$HashMb = 16,
  # Extra Chrome extension ids allowed to talk to the helper (the store id is always allowed).
  # Pass your unpacked-development id here; find it on chrome://extensions after loading the folder.
  [string[]]$ExtensionId = @(),
  # Also register the host for Firefox (uses the extension's Gecko id).
  [switch]$Firefox,
  # Keep the existing config.json and only refresh the helper + registration.
  [switch]$KeepConfig,
  # Skip compilation (the helper exe from a previous install is reused).
  [switch]$NoCompile
)

$ErrorActionPreference = "Stop"

$Host_ = "com.chessreview.native_engine"
$StoreId = "pdbffcjdmcadihmnmenkadndbdbigfam"       # Chrome Web Store id of Chess Review
$GeckoId = "{04a623e1-ee4d-4b46-81f7-4790bbe6a59c}" # Firefox Add-ons id of Chess Review
$Source = Join-Path $PSScriptRoot "host\ChessReviewHost.cs"
$InstallDir = Join-Path $env:LOCALAPPDATA "ChessReview\native-host"
$HostExe = Join-Path $InstallDir "ChessReviewHost.exe"
$ManifestPath = Join-Path $InstallDir "host-manifest.json"
$FirefoxManifestPath = Join-Path $InstallDir "host-manifest.firefox.json"

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-EnginePath([string]$Path) {
  if ([String]::IsNullOrWhiteSpace($Path)) {
    throw "No -EnginePath given. Download a genuine Stockfish 19 Windows build, then pass its full path, e.g.:`n" +
          '  -EnginePath "C:\Tools\Stockfish\stockfish-windows-x86-64-avx2.exe"'
  }
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "EnginePath does not exist: $full" }
  return $full
}

Write-Host "== Chess Review native engine helper =="

# 1. Install directory + helper executable -----------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$compiled = $false
if (-not $NoCompile -or -not (Test-Path -LiteralPath $HostExe)) {
  # A helper currently held open by a running browser cannot be overwritten; stop exactly our own
  # exe (matched by its installed path, never by name) so an update/re-install works in place.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $HostExe } |
    ForEach-Object { Write-Host "Stopping the running helper (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400

  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
  if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found - the .NET Framework 4.x compiler is missing." }
  Write-Host "Compiling the helper with $csc"
  & $csc /nologo /target:exe /optimize+ /platform:anycpu "/out:$HostExe" `
    /r:System.dll /r:System.Core.dll /r:System.Web.Extensions.dll $Source
  if ($LASTEXITCODE -ne 0) { throw "Compilation failed." }
  $compiled = $true
}

# 2. Configuration -----------------------------------------------------------------------
$ConfigPath = Join-Path $InstallDir "config.json"
if ($KeepConfig -and (Test-Path -LiteralPath $ConfigPath)) {
  Write-Host "Keeping the existing config.json"
} else {
  $engine = $EnginePath
  if ([String]::IsNullOrWhiteSpace($engine) -and (Test-Path -LiteralPath $ConfigPath)) {
    try {
      $existing = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $engine = $existing.enginePath
    } catch { $engine = "" }
  }
  $engineValue = ""
  if (-not [String]::IsNullOrWhiteSpace($engine)) { $engineValue = [System.IO.Path]::GetFullPath($engine) }
  $evalValue = ""
  if (-not [String]::IsNullOrWhiteSpace($EvalFile)) { $evalValue = [System.IO.Path]::GetFullPath($EvalFile) }
  $config = [ordered]@{
    enginePath = $engineValue
    engineArgs = @()
    evalFile = $evalValue
    threads = [Math]::Max(1, [Math]::Min(64, $Threads))
    hashMb = [Math]::Max(1, [Math]::Min(4096, $HashMb))
    searchTimeoutMs = 120000
    logFile = ""
  }
  Write-Utf8NoBom $ConfigPath ($config | ConvertTo-Json)
}

if (-not $compiled) { Write-Host "Helper already compiled; reusing $HostExe" }
Write-Host "Config written to $ConfigPath"

# 3. Host manifest + registration --------------------------------------------------------
$origins = @("chrome-extension://$StoreId/")
foreach ($id in $ExtensionId) {
  if ([String]::IsNullOrWhiteSpace($id)) { continue }
  $origins += "chrome-extension://$($id.Trim())/"
}

$manifest = [ordered]@{
  name = $Host_
  description = "Runs a locally installed Stockfish 19 executable for the Chess Review extension."
  path = $HostExe
  type = "stdio"
  allowed_origins = $origins
}
Write-Utf8NoBom $ManifestPath ($manifest | ConvertTo-Json)

# Chromium browsers read this registry key (Brave/Edge/Chromium inherit the Google\Chrome one).
function Ensure-Key([string]$Path) {
  # New-Item -Force misbehaves on registry paths that do not exist yet, so create only what's missing.
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
}
$registryRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
)
foreach ($root in $registryRoots) {
  Ensure-Key $root
  Ensure-Key (Join-Path $root $Host_)
  Set-ItemProperty -Path (Join-Path $root $Host_) -Name "(default)" -Value $ManifestPath
}
Write-Host "Registered for Chrome / Chromium / Brave / Edge (per-user)"

if ($Firefox) {
  $fx = [ordered]@{
    name = $Host_
    description = $manifest.description
    path = $HostExe
    type = "stdio"
    allowed_extensions = @($GeckoId) + @($ExtensionId | Where-Object { $_ -match "^\{|\@" })
  }
  Write-Utf8NoBom $FirefoxManifestPath ($fx | ConvertTo-Json)
  Ensure-Key "HKCU:\Software\Mozilla\NativeMessagingHosts\$Host_"
  Set-ItemProperty -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\$Host_" -Name "(default)" -Value $FirefoxManifestPath
  Write-Host "Registered for Firefox"
}

# 4. Summary -----------------------------------------------------------------------------
Write-Host ""
$configured = ""
try { $configured = (Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).enginePath } catch {}
if ([String]::IsNullOrWhiteSpace($configured)) {
  Write-Warning "No engine is configured yet. Reviews will use the bundled WASM engine until you run this script with -EnginePath."
} else {
  Write-Host "Engine: $configured"
}
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open the extension's Settings > Engine tab and pick Build: Stockfish 19 (Native)."
Write-Host "  2. Press Recheck - the helper is detected without reloading."
Write-Host "  3. If antivirus blocks the first launch, add an exclusion for $InstallDir."
Write-Host "Uninstall any time with: powershell -ExecutionPolicy Bypass -File native\uninstall.ps1"
