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
  [string]$ExpectedSha256 = "",
  # The repository normally carries the engine in native\engine. When that copy is missing (a source
  # snapshot without it, or this script downloaded on its own), it is fetched from the official
  # Stockfish release and verified against native\engine\checksums.json before anything is installed.
  # Pass this switch to refuse the download and fail instead (offline / air-gapped installs).
  [switch]$NoEngineDownload,
  # Redo the whole install even when it is already in place and unchanged, including the self-test.
  # Without it a second run is a no-op: nothing is compiled, copied or started.
  [switch]$Force
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

# The only engine this installer will fetch, and only when the repository does not already carry it.
# The official Stockfish 19 Windows universal build: the same bytes native/engine/checksums.json pins,
# verified below before use. Nothing here trusts the download.
$OfficialEngineUrl = "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip"

function Get-OfficialStockfish([string]$EngineDir, [string]$ExeName) {
  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) (Split-Path -Leaf $OfficialEngineUrl)
  $extractDir = Join-Path ([System.IO.Path]::GetTempPath()) ("chess-review-sf19-" + [Guid]::NewGuid().ToString("n"))
  Write-Host "The engine is not bundled in this copy; downloading the official Stockfish 19 (about 78 MB, one time)..."
  Write-Host "  $OfficialEngineUrl"
  # GitHub requires TLS 1.2, which Windows PowerShell 5.1 does not always negotiate on its own.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
  # The progress bar makes Invoke-WebRequest several times slower on PowerShell 5.1 for no benefit.
  $previousProgress = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    Invoke-WebRequest -Uri $OfficialEngineUrl -OutFile $zipPath -UseBasicParsing
  } finally {
    $ProgressPreference = $previousProgress
  }
  try {
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $found = Get-ChildItem -LiteralPath $extractDir -Recurse -File -Filter $ExeName | Select-Object -First 1
    if (-not $found) { throw "The official archive did not contain $ExeName." }
    if (-not (Test-Path -LiteralPath $EngineDir)) { New-Item -ItemType Directory -Path $EngineDir -Force | Out-Null }
    $target = Join-Path $EngineDir $ExeName
    Copy-Item -LiteralPath $found.FullName -Destination $target -Force
    Unblock-File -LiteralPath $target -ErrorAction SilentlyContinue
    Write-Host "Unpacked the official Stockfish 19 (its SHA-256 is checked next)."
  } finally {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
  }
}

# The recorded hash is what makes a download trustworthy; fetching the engine without it would be
# asking the user to trust whatever arrived. Read it, and treat "no record" as a hard failure.
function Get-RecordedEngineSha([string]$ChecksumsPath, [string]$ExeName) {
  try {
    $manifest = Get-Content -LiteralPath $ChecksumsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in @($manifest)) {
      if ($entry.file -eq $ExeName -and -not [String]::IsNullOrWhiteSpace([string]$entry.sha256)) {
        return ([string]$entry.sha256).Trim().ToLowerInvariant()
      }
    }
  } catch { }
  return ""
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

# 0. Is this install already in place and unchanged? ------------------------------------
# A repeated run must not do any work. Compiling again produces a brand-new unsigned binary that no
# antivirus has seen before (so every run is scanned from scratch, and may even be blocked), and the
# self-test then launches it plus the 100 MB engine for nothing. Everything below is skipped when the
# installed helper, its config and every browser registration already match this copy of the source.
# -Force (or any explicit option) always does the full install.
$PrebuiltExe = Join-Path $PSScriptRoot "host\ChessReviewHost.exe"
$PrebuiltChecksums = Join-Path $PSScriptRoot "host\checksums.json"
$ConfigPath = Join-Path $InstallDir "config.json"
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$DesiredOrigins = @("chrome-extension://$StoreId/")
foreach ($id in (@($ExtensionId) + @(Find-UnpackedExtensionIds $RepoRoot))) {
  if ([String]::IsNullOrWhiteSpace($id)) { continue }
  $clean = ([string]$id).Trim()
  if ($clean -match '^[a-p]{32}$') {
    $origin = "chrome-extension://$clean/"
    if ($DesiredOrigins -notcontains $origin) { $DesiredOrigins += $origin }
  }
}

# What a build from this folder would produce: the prebuilt binary's pinned bytes when it is present
# and matches its record, otherwise the hash of the helper source.
function Get-HelperIdentity {
  if (Test-Path -LiteralPath $PrebuiltExe) {
    $recorded = Get-RecordedEngineSha -ChecksumsPath $PrebuiltChecksums -ExeName (Split-Path -Leaf $PrebuiltExe)
    if (-not [String]::IsNullOrWhiteSpace($recorded)) {
      try {
        if ((Get-FileHash -LiteralPath $PrebuiltExe -Algorithm SHA256).Hash.ToLowerInvariant() -eq $recorded) {
          return "prebuilt:$recorded"
        }
      } catch { }
    }
  }
  if (Test-Path -LiteralPath $Source) {
    try { return "source:" + (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant() } catch { }
  }
  return ""
}

function Test-InstallCurrent([string]$HelperId, [string[]]$Origins) {
  if ([String]::IsNullOrWhiteSpace($HelperId)) { return $false }
  if (-not (Test-Path -LiteralPath $HostExe)) { return $false }
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }
  $config = $null
  try { $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
  # Built from the same source (or the same prebuilt binary) as this folder would build now.
  if ([string]$config.helperId -ne $HelperId) { return $false }
  # The engine it points at is still there, and still the bytes that were pinned for it.
  $engine = [string]$config.enginePath
  if ([String]::IsNullOrWhiteSpace($engine) -or -not (Test-Path -LiteralPath $engine -PathType Leaf)) { return $false }
  $pin = ([string]$config.expectedSha256).Trim().ToLowerInvariant()
  if (-not [String]::IsNullOrWhiteSpace($pin)) {
    try { if ((Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin) { return $false } } catch { return $false }
  }
  # Every browser that must be able to reach the helper already can, at this exact path.
  foreach ($manifestPath in @($ManifestPath, $FirefoxManifestPath)) {
    if (-not (Test-Path -LiteralPath $manifestPath)) {
      if ($manifestPath -eq $FirefoxManifestPath) { continue }   # Firefox is opt-in
      return $false
    }
    $manifest = $null
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
    if ([string]$manifest.path -ne $HostExe) { return $false }
    foreach ($origin in $Origins) {
      if (@($manifest.allowed_origins) -notcontains $origin) { return $false }
    }
  }
  return $true
}

$helperId = Get-HelperIdentity
$explicitChange = $Force -or $KeepConfig -or $NoCompile -or $NoEngineDownload -or $Firefox -or
  (-not [String]::IsNullOrWhiteSpace($EnginePath)) -or
  (-not [String]::IsNullOrWhiteSpace($ExpectedSha256)) -or
  (@($ExtensionId).Count -gt 0)
if (-not $explicitChange) {
  $currentEngine = ""
  try { $currentEngine = [string]((Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8) | ConvertFrom-Json).enginePath } catch { }
  if (Test-InstallCurrent -HelperId $helperId -Origins $DesiredOrigins) {
    Write-Host "Already installed and unchanged - nothing to do."
    Write-Host "  Helper: $HostExe"
    Write-Host "  Engine: $currentEngine"
    Write-Host "  Registered for: $($DesiredOrigins -join ', ')"
    Write-Host "Press Recheck in Settings > Engine > Build if the extension has not noticed it yet."
    Write-Host "(Re-run with -Force to rebuild and self-test anyway.)"
    exit 0
  }
}

# 1. Install directory + helper executable -----------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# A PREBUILT helper (native/host/ChessReviewHost.exe, hash-recorded in native/host/checksums.json) is
# used when present and matching: one stable binary for every user, so antivirus reputation
# accumulates instead of resetting on each install. Compiling locally with the in-box csc.exe is the
# fallback (no prebuilt committed yet, or its bytes do not match the record). Both paths are resolved
# at the top of this script; see Get-HelperIdentity.
$compiled = $false
$usedPrebuilt = $false
if ($NoCompile -and (Test-Path -LiteralPath $HostExe)) {
  Write-Host "Keeping the installed helper ($HostExe)"
} else {
  # A helper currently held open by a running browser cannot be overwritten; stop exactly our own
  # exe (matched by its installed path, never by name) so an update/re-install works in place.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $HostExe } |
    ForEach-Object { Write-Host "Stopping the running helper (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
  
  $prebuiltOk = $false
  if (Test-Path -LiteralPath $PrebuiltExe) {
    $recorded = ""
    try {
      $manifest = Get-Content -LiteralPath $PrebuiltChecksums -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($entry in @($manifest)) {
        if ($entry.file -eq (Split-Path -Leaf $PrebuiltExe)) { $recorded = [string]$entry.sha256 }
      }
    } catch { $recorded = "" }
    if (-not [String]::IsNullOrWhiteSpace($recorded)) {
      $actual = (Get-FileHash -LiteralPath $PrebuiltExe -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -eq $recorded.ToLowerInvariant()) { $prebuiltOk = $true }
      else { Write-Warning "The prebuilt helper does not match the hash recorded in host\checksums.json - it will be rebuilt from source." }
    } else {
      Write-Warning "No hash recorded for the prebuilt helper (host\checksums.json) - it will be rebuilt from source."
    }
  }
  if ($prebuiltOk) {
    Copy-Item -LiteralPath $PrebuiltExe -Destination $HostExe -Force
    $usedPrebuilt = $true
    Write-Host "Using the prebuilt helper (SHA-256 verified against host\checksums.json)"
  } else {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
    if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found - the .NET Framework 4.x compiler is missing." }
    Write-Host "Compiling the helper with $csc"
    & $csc /nologo /target:exe /optimize+ /platform:anycpu "/out:$HostExe" `
      /r:System.dll /r:System.Core.dll /r:System.Web.Extensions.dll $Source
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed." }
    $compiled = $true
  }
}
Unblock-File -LiteralPath $HostExe -ErrorAction SilentlyContinue

# 1b. Engine ------------------------------------------------------------------------------
# By default the helper runs the OFFICIAL Stockfish 19 build this repository carries, copied into the
# install folder (so the install keeps working even if this repo folder is later moved or deleted) and
# hash-pinned automatically. When the copy is missing, the same official build is downloaded and
# verified against the recorded SHA-256 first - see Get-OfficialStockfish above. -EnginePath still
# selects a custom executable.
$BundledEngine = Join-Path $PSScriptRoot "engine\stockfish-windows-x86-64-universal.exe"
$BundledChecksums = Join-Path $PSScriptRoot "engine\checksums.json"
if ([String]::IsNullOrWhiteSpace($EnginePath)) {
  $engineExe = Split-Path -Leaf $BundledEngine
  $downloaded = $false
  if (-not (Test-Path -LiteralPath $BundledEngine)) {
    if ($NoEngineDownload) {
      throw "No -EnginePath given and the engine is not in this copy: $BundledEngine`n" +
            "Re-run without -NoEngineDownload to fetch the official Stockfish 19 automatically, or pass -EnginePath."
    }
    Get-OfficialStockfish -EngineDir (Split-Path -Parent $BundledEngine) -ExeName $engineExe
    $downloaded = $true
  }
  # The repo records the official binary's SHA-256 (native/engine/checksums.json). Never install an
  # engine whose bytes do not match that record.
  $recorded = Get-RecordedEngineSha -ChecksumsPath $BundledChecksums -ExeName $engineExe
  if ($downloaded -and [String]::IsNullOrWhiteSpace($recorded)) {
    # These bytes just came off the network. Without the record there is nothing to check them
    # against, and installing an unverified engine is the one thing this installer must never do.
    throw "Downloaded Stockfish, but $BundledChecksums records no SHA-256 for $engineExe, so the download cannot be verified.`n" +
          "Refusing to install an unverified engine. Restore native\engine\checksums.json and try again."
  }
  $bundledHash = (Get-FileHash -LiteralPath $BundledEngine -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [String]::IsNullOrWhiteSpace($recorded)) {
    if ($bundledHash -ne $recorded) {
      throw "The Stockfish executable does not match the SHA-256 recorded in native\engine\checksums.json.`n" +
            "  recorded: $recorded`n  actual:   $bundledHash`n" +
            "Do not install it. Re-download the repository (or the official release) and try again."
    }
    Write-Host "Engine verified against native\engine\checksums.json"
  }
  $InstalledEngine = Join-Path $InstallDir "stockfish.exe"
  Copy-Item -LiteralPath $BundledEngine -Destination $InstalledEngine -Force
  Unblock-File -LiteralPath $InstalledEngine -ErrorAction SilentlyContinue
  $EnginePath = $InstalledEngine
  # Pin automatically: "verified Stockfish 19" then means the official binary, byte for byte.
  if ([String]::IsNullOrWhiteSpace($ExpectedSha256)) { $ExpectedSha256 = $bundledHash }
  $origin = if ($downloaded) { "downloaded" } else { "bundled" }
  Write-Host "Using the official Stockfish 19 ($origin) - installed to $InstalledEngine"
}

# 2. Configuration -----------------------------------------------------------------------
# ($ConfigPath, $PrebuiltExe and $PrebuiltChecksums are resolved in section 0 above.)
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
      $existing.helperId = $helperId
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
    # What produced the helper that is being installed (the prebuilt binary's hash, or the hash of the
    # source that was compiled). A repeat run compares this to decide that nothing changed and skip
    # the rebuild entirely - see section 0. The helper itself ignores unknown keys.
    helperId = $helperId
    logFile = ""
  }
  Write-Utf8NoBom $ConfigPath ($config | ConvertTo-Json)
}

if (-not $compiled) { Write-Host "Helper already compiled; reusing $HostExe" }
Write-Host "Config written to $ConfigPath"

# 3. Host manifest + registration --------------------------------------------------------
# ($RepoRoot and the detected extension ids are resolved in section 0 above; $origins here is the
# same list in the order the manifest writes it.)
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
