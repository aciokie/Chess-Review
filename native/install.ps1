# native/install.ps1 - per-user install of the Chess Review native engine helper.
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
# Your unpacked (developer-mode) copy of the extension is found automatically in Brave / Chrome / Edge /
# Chromium profiles, so -ExtensionId is normally NOT needed any more. The installer ends with a self-test
# that starts the helper (and Stockfish) once and tells you what it found.
#
# After installing, reload the extension and press "Recheck" in Settings > Engine > Build.

[CmdletBinding()]
param(
  # Absolute path to a custom Stockfish 19 Windows executable. OPTIONAL: when omitted, the installer
  # uses the official Stockfish 19 build bundled in native\engine (verified against its recorded
  # SHA-256, copied into the install folder and hash-pinned automatically).
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
  [switch]$NoCompile,
  # Skip the final self-test (it starts the helper and Stockfish once, then closes them).
  [switch]$SkipSelfTest,
  # Optional SHA-256 of the engine executable. When set (it is set automatically for the bundled
  # engine), the helper checks the binary itself at every start, so "verified Stockfish 19" means a
  # hash match, not just the engine's own claim.
  # Get the hash with:  Get-FileHash "D:\Downlaods\Stockfish19\stockfish-windows-x86-64-*.exe" -Algorithm SHA256
  [string]$ExpectedSha256 = ""
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

# Chromium browsers refuse a Native Messaging connection from an extension id that is not on the
# host manifest's allowed_origins list. An unpacked (developer-mode) copy gets an id derived from its
# folder path, so look it up: every browser profile records the folder each unpacked extension was
# loaded from. Returns the ids whose folder is exactly $ExtensionDir. Never throws.
function Find-UnpackedExtensionIds([string]$ExtensionDir) {
  $found = @()
  $wanted = $ExtensionDir.TrimEnd('\', '/')
  try { Add-Type -AssemblyName System.Web.Extensions } catch { return @() }
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\User Data"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"),
    (Join-Path $env:LOCALAPPDATA "Chromium\User Data")
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $profiles = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq "Default" -or $_.Name -like "Profile *" })
    foreach ($profileDir in $profiles) {
      foreach ($name in @("Secure Preferences", "Preferences")) {
        $file = Join-Path $profileDir.FullName $name
        if (-not (Test-Path -LiteralPath $file)) { continue }
        try {
          # The browser keeps this file open, so read it with a shared handle.
          $stream = New-Object System.IO.FileStream($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
          try {
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $text = $reader.ReadToEnd()
          } finally { $stream.Dispose() }
          $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
          $serializer.MaxJsonLength = [int]::MaxValue
          $serializer.RecursionLimit = 1000
          $data = $serializer.DeserializeObject($text)
            $extensions = $data["extensions"]
            $settings = $null
            if ($extensions -is [System.Collections.IDictionary] -and $extensions.ContainsKey("settings")) { $settings = $extensions["settings"] }
            if ($null -eq $settings -or -not ($settings -is [System.Collections.IDictionary])) { continue }
          foreach ($id in @($settings.Keys)) {
            $entry = $settings[$id]
            if (-not ($entry -is [System.Collections.IDictionary])) { continue }
            if (-not $entry.ContainsKey("path")) { continue }
            $entryPath = [string]$entry["path"]
            if ($entryPath.TrimEnd('\', '/') -ieq $wanted -and $id -match '^[a-p]{32}$') { $found += [string]$id }
          }
        } catch { }
      }
    }
  }
  return @($found | Select-Object -Unique)
}

# Read exactly $Count bytes from a stream before $Deadline. Returns $null on timeout or end of stream.
function Read-ExactBytes($Stream, [int]$Count, [DateTime]$Deadline) {
  $buffer = New-Object byte[] $Count
  $got = 0
  while ($got -lt $Count) {
    $remaining = [int][Math]::Max(1, ($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
    $task = $Stream.ReadAsync($buffer, $got, $Count - $got)
    if (-not $task.Wait($remaining)) { return $null }
    if ($task.Result -le 0) { return $null }
    $got += $task.Result
  }
  return ,$buffer
}

# Read one Native Messaging frame (4-byte little-endian length + UTF-8 JSON). $null on failure.
function Read-HostFrame($Stream, [DateTime]$Deadline) {
  $header = Read-ExactBytes $Stream 4 $Deadline
  if ($null -eq $header) { return $null }
  $length = [BitConverter]::ToInt32($header, 0)
  if ($length -lt 1 -or $length -gt 1048576) { return $null }
  $payload = Read-ExactBytes $Stream $length $Deadline
  if ($null -eq $payload) { return $null }
  try { return ([System.Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json) } catch { return $null }
}

# Start the installed helper exactly like the browser does, wait for its "hello" and, when an engine
# is configured, ask it to start Stockfish and report what it is. Always stops what it started.
function Test-Helper([string]$Exe, [bool]$StartEngine) {
  $summary = [pscustomobject]@{ Ok = $false; Detail = ""; EngineName = ""; Verified = $false; HashVerified = $true; EngineSha256 = "" }
  $proc = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.BaseStream
    $hello = Read-HostFrame $stdout ([DateTime]::UtcNow.AddSeconds(30))
    if ($null -eq $hello -or $hello.type -ne "hello") {
      $summary.Detail = "the helper did not answer within 30 s (antivirus may be scanning it) or it exited at once"
      return $summary
    }
    $summary.Ok = $true
    $summary.Detail = "helper version " + [string]$hello.version
    if ($StartEngine) {
      $payload = [System.Text.Encoding]::UTF8.GetBytes('{"type":"init","options":{}}')
      $stdin = $proc.StandardInput.BaseStream
      $stdin.Write([BitConverter]::GetBytes([int]$payload.Length), 0, 4)
      $stdin.Write($payload, 0, $payload.Length)
      $stdin.Flush()
      $deadline = [DateTime]::UtcNow.AddSeconds(60)
      while ($true) {
        $frame = Read-HostFrame $stdout $deadline
        if ($null -eq $frame) { $summary.Ok = $false; $summary.Detail = "Stockfish did not start within 60 s"; break }
        if ($frame.type -eq "ready") {
          $summary.EngineName = [string]$frame.engine.name
          $summary.Verified = ($frame.engine.verified -eq $true)
          $summary.HashVerified = ($frame.engine.hashVerified -ne $false)
          $summary.EngineSha256 = [string]$frame.engine.sha256
          break
        }
        if ($frame.type -eq "error") { $summary.Ok = $false; $summary.Detail = [string]$frame.message; break }
      }
    }
  } catch {
    $summary.Ok = $false
    $summary.Detail = $_.Exception.Message
  } finally {
    if ($null -ne $proc) {
      try { $proc.StandardInput.Close() } catch { }
      try { if (-not $proc.WaitForExit(4000)) { $proc.Kill() } } catch { }
    }
  }
  return $summary
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
Unblock-File -LiteralPath $HostExe -ErrorAction SilentlyContinue

# 1b. Engine ------------------------------------------------------------------------------
# By default the helper runs the OFFICIAL Stockfish 19 build bundled in this repository, copied into
# the install folder (so the install keeps working even if this repo folder is later moved or
# deleted) and hash-pinned automatically. -EnginePath still selects a custom executable.
$BundledEngine = Join-Path $PSScriptRoot "engine\stockfish-windows-x86-64-universal.exe"
$BundledChecksums = Join-Path $PSScriptRoot "engine\checksums.json"
if ([String]::IsNullOrWhiteSpace($EnginePath)) {
  if (-not (Test-Path -LiteralPath $BundledEngine)) {
    throw "No -EnginePath given and the bundled engine is missing: $BundledEngine"
  }
  # The repo records the official binary's SHA-256 (native/engine/checksums.json). Never install a
  # bundled engine whose bytes do not match that record.
  $recorded = ""
  try {
    $manifest = Get-Content -LiteralPath $BundledChecksums -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in @($manifest)) {
      if ($entry.file -eq (Split-Path -Leaf $BundledEngine)) { $recorded = [string]$entry.sha256 }
    }
  } catch { $recorded = "" }
  $bundledHash = (Get-FileHash -LiteralPath $BundledEngine -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [String]::IsNullOrWhiteSpace($recorded)) {
    if ($bundledHash -ne $recorded.ToLowerInvariant()) {
      throw "The bundled Stockfish executable does not match the SHA-256 recorded in native\engine\checksums.json.`n" +
            "  recorded: $($recorded.ToLowerInvariant())`n  actual:   $bundledHash`n" +
            "Do not install it. Re-download the repository (or the official release) and try again."
    }
    Write-Host "Bundled engine verified against native\engine\checksums.json"
  }
  $InstalledEngine = Join-Path $InstallDir "stockfish.exe"
  Copy-Item -LiteralPath $BundledEngine -Destination $InstalledEngine -Force
  Unblock-File -LiteralPath $InstalledEngine -ErrorAction SilentlyContinue
  $EnginePath = $InstalledEngine
  # Pin automatically: "verified Stockfish 19" then means the official binary, byte for byte.
  if ([String]::IsNullOrWhiteSpace($ExpectedSha256)) { $ExpectedSha256 = $bundledHash }
  Write-Host "Using the bundled official Stockfish 19 (installed to $InstalledEngine)"
}

# 2. Configuration -----------------------------------------------------------------------
$ConfigPath = Join-Path $InstallDir "config.json"
# Normalise the pinned hash (accepts "SHA256:" prefixed output from Get-FileHash).
$ExpectedSha = ""
if (-not [String]::IsNullOrWhiteSpace($ExpectedSha256)) {
  $ExpectedSha = ([string]$ExpectedSha256).Trim()
  if ($ExpectedSha -match '^(?i)sha256:') { $ExpectedSha = $ExpectedSha.Substring(7) }
  $ExpectedSha = $ExpectedSha.Trim().ToLowerInvariant()
  if ($ExpectedSha -notmatch '^[0-9a-f]{64}$') {
    throw "-ExpectedSha256 must be the 64 hex characters of the engine's SHA-256 (see Get-FileHash). Got: '$ExpectedSha256'"
  }
  if ([String]::IsNullOrWhiteSpace($EnginePath)) { throw "-ExpectedSha256 needs -EnginePath too (the hash is pinned against that file)." }
  $actual = (Get-FileHash -LiteralPath ([System.IO.Path]::GetFullPath($EnginePath)) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha) {
    throw "The engine .exe does NOT match the SHA-256 you pinned:`n  pinned: $ExpectedSha`n  actual: $actual`n" +
          "Do not install this binary. Download Stockfish 19 again from stockfishchess.org and re-check."
  }
  Write-Host "Engine SHA-256 verified against your pin: $ExpectedSha"
}
if ($KeepConfig -and (Test-Path -LiteralPath $ConfigPath)) {
  Write-Host "Keeping the existing config.json"
  if (-not [String]::IsNullOrWhiteSpace($ExpectedSha)) {
    # Still record the pin: -KeepConfig refreshes the registration, and a new pin must land too.
    try {
      $existing = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $existing.expectedSha256 = $ExpectedSha
      Write-Utf8NoBom $ConfigPath ($existing | ConvertTo-Json -Depth 5)
    } catch { Write-Warning "Could not record the pinned hash into the existing config.json: $($_.Exception.Message)" }
  }
} else {
  $engine = $EnginePath
  if ([String]::IsNullOrWhiteSpace($engine) -and (Test-Path -LiteralPath $ConfigPath)) {
    try {
      $existing = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $engine = $existing.enginePath
      if ([String]::IsNullOrWhiteSpace($ExpectedSha) -and $existing.expectedSha256) { $ExpectedSha = [string]$existing.expectedSha256 }
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
    expectedSha256 = $ExpectedSha
    logFile = ""
  }
  Write-Utf8NoBom $ConfigPath ($config | ConvertTo-Json)
}

if (-not $compiled) { Write-Host "Helper already compiled; reusing $HostExe" }
Write-Host "Config written to $ConfigPath"

# 3. Host manifest + registration --------------------------------------------------------
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$origins = @("chrome-extension://$StoreId/")
$allowedIds = @()
foreach ($id in $ExtensionId) {
  if ([String]::IsNullOrWhiteSpace($id)) { continue }
  $clean = $id.Trim()
  if ($clean -match '^[a-p]{32}$') { $allowedIds += $clean }
  elseif ($clean -notmatch '^\{|@') { Write-Warning "Ignoring -ExtensionId '$clean': a Chrome/Brave/Edge extension id is 32 letters a-p." }
}
# Find the id of the unpacked copy of THIS folder, so a developer-mode install is allowed to talk to the helper.
$detectedIds = @(Find-UnpackedExtensionIds $RepoRoot)
foreach ($id in $detectedIds) { if ($allowedIds -notcontains $id) { $allowedIds += $id } }
if ($detectedIds.Count -gt 0) {
  Write-Host "Found your unpacked extension id: $($detectedIds -join ', ')"
} elseif ($allowedIds.Count -eq 0) {
  Write-Warning ("No unpacked copy of this folder ($RepoRoot) was found in Brave / Chrome / Edge. If you run Chess Review from this " +
    "folder, load it on the extensions page (Developer mode > Load unpacked), then run this script again - otherwise the " +
    "browser will refuse to talk to the helper. (Ignore this if you use the Chrome Web Store version.)")
}
foreach ($id in $allowedIds) { $origins += "chrome-extension://$id/" }

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
if (-not $SkipSelfTest) {
  Write-Host ""
  Write-Host "Self-test: starting the helper once (this also starts Stockfish and can take a few seconds)..."
  $hasEngine = -not [String]::IsNullOrWhiteSpace($configured)
  $test = Test-Helper $HostExe $hasEngine
  if (-not $test.Ok) {
    Write-Warning "Self-test FAILED: $($test.Detail)"
    Write-Warning "If antivirus (for example Avast CyberCapture) is scanning the new files, wait for it to finish or allow them, add an exclusion for $InstallDir, then run this script again."
  } else {
    Write-Host "Self-test OK ($($test.Detail))"
    if ($hasEngine) {
      Write-Host "Engine SHA-256: $($test.EngineSha256)"
      if ($test.Verified) {
        if ($test.HashVerified) {
          Write-Host "Engine identifies itself as: $($test.EngineName)  [verified Stockfish 19 - id name AND SHA-256 match your pin]"
        } else {
          # Cannot happen today (a pin is validated before install), kept for honesty if a hash is
          # added to an existing config without -EnginePath.
          Write-Host "Engine identifies itself as: $($test.EngineName)  [Stockfish 19 by id name; SHA-256 not pinned]"
        }
      } elseif ($test.HashVerified -eq $false) {
        Write-Warning "The engine binary does NOT match the pinned SHA-256 - this is not the executable you pinned. Re-download Stockfish 19 from stockfishchess.org and re-run this script."
      } else {
        Write-Warning "The engine identifies itself as '$($test.EngineName)', which is NOT Stockfish 19 (its id name is a self-declaration). Download the official Stockfish 19 build and re-run this script with -EnginePath."
        Write-Warning "To prove the binary itself, add: -ExpectedSha256 (Get-FileHash '<engine>.exe' -Algorithm SHA256).Hash"
      }
    }
  }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  0. Reload the extension on the extensions page once (it needs the nativeMessaging permission)."
Write-Host "  1. Open the extension's Settings > Engine tab and pick Build: Stockfish 19 (Native)."
Write-Host "  2. Press Recheck - the helper is detected without reloading."
Write-Host "  3. If antivirus blocks the first launch, add an exclusion for $InstallDir."
Write-Host "Uninstall any time with: powershell -ExecutionPolicy Bypass -File native\uninstall.ps1"
