# update-extension.ps1 - one-click updater for the Chess Review extension folder. No git needed.
#
# It asks GitHub which files changed since your copy and downloads ONLY those (the Stockfish
# engines are ~200 MB, so re-downloading a zip every time would be slow). Every download is
# verified against GitHub's own checksum before it replaces your file. Nothing is ever deleted,
# and anything that is not in the repository (your own files) is left alone.
#
# Usage: double-click "Update Extension.bat" in this folder, or run this script from the folder.
# Afterwards open chrome://extensions and press the reload button on Chess Review.
#
# Windows PowerShell 5.1 rules (see AGENTS.md): keep this file pure ASCII + UTF-8 BOM.
param(
  [string]$Owner  = 'aciokie',
  [string]$Repo   = 'Chess-Review',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = $PSScriptRoot
if ([string]::IsNullOrEmpty($root)) { $root = (Get-Location).Path }
$headers = @{ 'User-Agent' = 'chess-review-updater' }
# The .bat that launches this script is never replaced while it is running.
$skip = @('Update Extension.bat')

# Git's blob checksum: SHA-1 of "blob <size><NUL><bytes>". Matches the sha GitHub lists per file.
function Get-BlobSha([string]$path) {
  $len = (Get-Item -LiteralPath $path).Length
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $head = [System.Text.Encoding]::ASCII.GetBytes("blob $len`0")
  [void]$sha.TransformBlock($head, 0, $head.Length, $null, 0)
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $buf = New-Object byte[] 1048576
    while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
      [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
    }
  } finally { $fs.Dispose() }
  [void]$sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
  return (($sha.Hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Save-File([string]$url, [string]$tmp) {
  $lastError = $null
  for ($try = 1; $try -le 3; $try++) {
    try { Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $url -OutFile $tmp; return }
    catch { $lastError = $_; Start-Sleep -Seconds 2 }
  }
  throw $lastError
}

try {
  Write-Host ""
  Write-Host "Chess Review updater"
  Write-Host "Folder: $root"
  Write-Host "Checking GitHub for the latest version..."

  # Pin to one exact commit so every file comes from the same version (and the raw-file CDN cache
  # can never serve a stale copy of something that was just fixed).
  $branchInfo = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/${Owner}/${Repo}/branches/${Branch}"
  $commit = $branchInfo.commit.sha
  $tree = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/${Owner}/${Repo}/git/trees/${commit}?recursive=1"
  if ($tree.truncated) { throw "GitHub returned a partial file list; try again later." }
  $blobs = @($tree.tree | Where-Object { $_.type -eq 'blob' })

  Write-Host "Comparing $($blobs.Count) files with your copy (the first run takes a moment)..."
  $updated = New-Object System.Collections.ArrayList
  $failed = New-Object System.Collections.ArrayList

  foreach ($e in $blobs) {
    $rel = [string]$e.path
    if ($skip -contains $rel) { continue }
    $dest = Join-Path $root ($rel -replace '/', '\')

    if (Test-Path -LiteralPath $dest -PathType Leaf) {
      if ((Get-BlobSha $dest) -eq $e.sha) { continue }     # already up to date
    }

    $tmp = [System.IO.Path]::GetTempFileName()
    try {
      $escaped = ($rel -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
      Save-File "https://raw.githubusercontent.com/${Owner}/${Repo}/${commit}/${escaped}" $tmp
      if ((Get-BlobSha $tmp) -ne $e.sha) { throw "download did not match GitHub's checksum" }
      $dir = Split-Path -Parent $dest
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Move-Item -LiteralPath $tmp -Destination $dest -Force
      [void]$updated.Add($rel)
      Write-Host "  updated  $rel"
    } catch {
      [void]$failed.Add("$rel  ($($_.Exception.Message))")
      Write-Host "  FAILED   $rel"
    } finally {
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
  }

  Write-Host ""
  $short = $commit.Substring(0, 7)
  if ($updated.Count -eq 0 -and $failed.Count -eq 0) {
    Write-Host "Already up to date (version $short). Nothing to do."
  } else {
    Write-Host "$($updated.Count) file(s) updated to version $short."
  }
  if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "These files could NOT be updated (is Chrome or the helper still using them? Close it and run again):"
    foreach ($f in $failed) { Write-Host "  $f" }
    exit 1
  }
  if ($updated -contains 'native/host/ChessReviewHost.exe') {
    Write-Host ""
    Write-Host "The native helper changed too: run 'Install Native Engine.bat' again to install the new one."
  }
  if ($updated.Count -gt 0) {
    Write-Host ""
    Write-Host "Last step: open chrome://extensions and press the reload button on Chess Review."
  }
} catch {
  Write-Host ""
  Write-Host "Update failed: $($_.Exception.Message)"
  exit 1
}
