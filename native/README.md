# Native Stockfish 19 (optional, Windows)

Chess Review normally analyzes games with **Stockfish WASM bundled inside the extension** — nothing
to install, works everywhere. This directory adds one optional extra for Windows: a small **Native
Messaging helper** that lets the extension drive a **native Stockfish 19 executable** you installed
yourself. Native code is considerably faster than WebAssembly, so reviews finish sooner at the same
depth.

Nothing here replaces or removes the bundled engines. If the helper is missing, misconfigured,
crashes, or hangs, the extension automatically falls back to the bundled WASM build and tells you so
in the Engine tab.

```
Chess Review extension  →  ChessReviewHost.exe (this helper, Native Messaging over stdio)
                        →  your Stockfish 19 executable (UCI over its stdin/stdout)
```

The helper is started **by the browser on demand** and exits as soon as the connection closes —
there is no background service, no server, no network access, no telemetry.

---

## 1. Get a genuine Stockfish 19 executable

The repo does **not** ship or download one (no large binaries, and the executable must be one you
chose and can trust). Download the official Windows build yourself, for example from
<https://stockfishchess.org/download/> (or the `official-release` assets on GitHub), and unpack it
anywhere, e.g. `C:\Tools\Stockfish\`.

* Use the **x86-64** Windows build that matches your CPU (the `universal` build picks the right CPU
  optimizations on its own). `dev-…` snapshots are unofficial test builds that report a name like
  `Stockfish dev-…`, which the helper deliberately does **not** accept as Stockfish 19.
* Stockfish 16 and newer **embed the default NNUE network**, so no separate `.nnue` file is needed.
  If your build is an exception, pass its network with `-EvalFile` (below).
* An engine's `id name` is only a **self-declaration** — any binary can print "Stockfish 19". To
  make verification cryptographic, pin the binary's SHA-256 with `-ExpectedSha256` (step 2): the
  helper then hashes the actual file at every start and only reports *verified* when it matches.

## 2. Install (per user, no administrator rights)

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File native\install.ps1 -EnginePath "C:\Tools\Stockfish\stockfish-windows-x86-64-avx2.exe"
```

This:

1. compiles `host\ChessReviewHost.cs` with the `csc.exe` that ships with Windows (.NET Framework 4.x
   — no SDK, no NuGet, nothing downloaded),
2. writes `%LOCALAPPDATA%\ChessReview\native-host\config.json`,
3. writes the Native Messaging host manifest next to it, and
4. registers it **for your user only** (`HKCU\Software\...\NativeMessagingHosts\com.chessreview.native_engine`)
   for Chrome, Chromium, Brave and Edge. Pass `-Firefox` to register it for Firefox too.

At the end the installer runs a **self-test**: it starts the helper exactly like the browser does, waits
for its reply, asks it to start Stockfish once and prints the engine's own `id name` **and its
SHA-256**. If antivirus is holding the new files, or the engine is not Stockfish 19, you see it right
there instead of discovering it later as a silent fallback.

**Proving the binary (recommended).** Pin the hash so "verified" means a cryptographic match, not a
self-declaration:

```powershell
$hash = (Get-FileHash "D:\Downlaods\Stockfish19\stockfish-windows-x86-64-universal.exe" -Algorithm SHA256).Hash
powershell -ExecutionPolicy Bypass -File native\install.ps1 -EnginePath "D:\Downlaods\Stockfish19\stockfish-windows-x86-64-universal.exe" -ExpectedSha256 $hash
```

Compare the hash against the one published with the release you downloaded. The installer refuses a
mismatched binary outright, and from then on the helper re-checks the file at every start: a
swapped or tampered `enginePath` is reported as unverified and the extension labels it honestly.

Extra options:

| Option | Meaning |
| --- | --- |
| `-ExtensionId "id1","id2"` | allow additional Chrome extension ids — the Chrome Web Store id is always allowed. **An unpacked (developer-mode) copy of this folder is found automatically** in your Brave / Chrome / Edge / Chromium profiles, so you normally don't need this; pass it only for an extension loaded from a different folder (find the id on the extensions page) |
| `-SkipSelfTest` | skip the final self-test (see below) |
| `-EvalFile "C:\path\nn-….nnue"` | external evaluation network for builds that don't embed one |
| `-Threads 1 -HashMb 16` | engine `Threads`/`Hash`. Keep `Threads` at 1: the extension already runs several engine instances in parallel, each with its own helper process |
| `-KeepConfig` | re-register without touching an existing `config.json` |
| `-NoCompile` | reuse the previously compiled helper exe |

## 3. Switch the extension to native

1. Open Chess Review → **Settings → Engine**.
2. Pick **Build: Stockfish 19 (Native)**.
3. The line under the Build row says whether the helper was found; press **Recheck** after
   installing/updating it (no reload needed).
4. The Engine panel header always shows the build that is **actually** running, and a cached review
   is only reused for the same build — native results are never mixed with WASM results.

Selecting the native build can only ever **fall back to the bundled builds** (Stockfish 18 NNUE →
19 Full → 19 Lite). A bundled build is never silently replaced by the native one.

## 4. Configuration reference

`config.json` next to `ChessReviewHost.exe` (see `host\Config.example.json`):

| Key | Meaning |
| --- | --- |
| `enginePath` | absolute path to the Stockfish executable (required) |
| `engineArgs` | extra engine command-line arguments (passed directly to the process, never via a shell) |
| `evalFile` | external `.nnue` network, if your build needs one |
| `threads` / `hashMb` | `Threads` / `Hash` defaults clamped to sane ranges |
| `searchTimeoutMs` | watchdog: a search silent for this long is failed and the engine reaped (default 120000) |
| `expectedSha256` | optional SHA-256 of the engine executable; when set, `verified` additionally requires the binary to match (written by `-ExpectedSha256`) |
| `logFile` | optional diagnostic log; stdout is reserved for the protocol. stderr is **opt-in** for debugging: set the environment variable `CHESS_REVIEW_HOST_DEBUG=1` before launching the browser |

`CHESS_REVIEW_ENGINE_PATH` (environment variable) overrides `enginePath`, which is handy for
portable setups.

## 5. Lifecycle, safety, and guarantees

* One connection = one helper process = **at most one Stockfish process**. A review that asks for N
  parallel workers gets exactly N helpers; repeated `init` on one connection never spawns a second
  engine.
* The helper terminates only processes it created itself (it never hunts for processes by name), and
  it holds the engine in a Windows **job object** with kill-on-close: even if the browser or
  antivirus force-kills the helper, the OS reaps the engine. No orphaned engines, no always-running
  service.
* Closing the review tab, closing the browser, finishing the review, or an engine crash all end with
  the engine stopped and the helper exited. Two further backstops keep it that way even when the
  browser dies abnormally: a helper with no traffic and no running search for 30 minutes exits by
  itself (it is never a background service), and its shutdown cannot hang on a wedged pipe.
* The engine is started with a few retries, because antivirus software can briefly deny process
  creation while it scans a just-installed executable.
* The extension validates everything the helper sends, and the helper validates everything the
  extension sends (frame size, message types, FEN, move history, search limits, UCI option names and
  values). A protocol violation is fatal: the helper reports the error and exits, and the review
  falls back to WASM.
* What the helper does **not** do: no network access, no telemetry, no secrets, no shell
  invocation, no writes outside its own install folder (and the optional log file you configure).

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| “Native helper not detected” | The line under the Build row now says *why* (the browser's own error). Re-run `native\install.ps1`, reload the extension (it needs the `nativeMessaging` permission) and press **Recheck**. *“Access … forbidden”* means this copy of the extension is not on the helper's allowed list — the installer now finds your unpacked extension id by itself (it must already be loaded in the browser when you run it); *“not found”* means the helper is not registered for this browser |
| Detected, but “no Stockfish executable is configured” | Re-run the installer with `-EnginePath`, or edit `config.json` |
| Engine shown as “unverified” / labelled “(native, not Stockfish 19)” | The helper marks an engine verified only when its own `id name` reports **Stockfish 19** (for example `Stockfish 19` or `Stockfish 19.1`) **and** — when you pinned `-ExpectedSha256` — the binary's SHA-256 matches. Any other version, a dev build or another engine still runs but is shown under its real name. Point `enginePath` at the official Stockfish 19 Windows build and pin its hash |
| First native review is slow or times out | Antivirus scans newly created executables on first run. Wait for one review to succeed, or add an exclusion for `%LOCALAPPDATA%\ChessReview\native-host` |
| Antivirus quarantines the helper | Restore it and exclude `%LOCALAPPDATA%\ChessReview\native-host`. The helper is plain C# compiled locally; `host\ChessReviewHost.cs` is the entire source |
| Reviews still say “Stockfish 18 NNUE (fallback)” | The helper ran but the engine failed to start — set `logFile` in `config.json` and check the log, then check that the engine runs from a terminal (`stockfish.exe`, then `uci`) |
| Deep diagnosis of the helper itself | Set `CHESS_REVIEW_HOST_DEBUG=1` and `logFile` in `config.json`, then reproduce; the log records startup, handshake, every search and the shutdown reason |
| Multiple engine processes during a review | Expected: one per parallel worker (Settings → Engine → Workers). They all exit when the review finishes |

## 7. Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File native\uninstall.ps1
```

Removes the four (or five, with Firefox) `HKCU` registrations created by the installer and the
`%LOCALAPPDATA%\ChessReview\native-host` folder. It never touches registry values, files or settings
it did not create, and it warns instead of deleting if a registration points somewhere else. The
extension keeps working with its bundled engines.

`-KeepFiles` unregisters only (keeps the helper and your `config.json`).

## 8. Development / testing

* `npm run test:native-host` compiles the helper and a UCI **test double** (`test\FakeEngine.cs` —
  clearly not a chess engine, never registered) and drives the real protocol end to end: framing,
  handshake, MultiPV, stop, crash detection, the silence watchdog, oversize/invalid frames, quit and
  EOF shutdown, and orphan reaping.
* `tests/native-engine.test.mjs` covers the extension-side adapter and the fallback behaviour.
* The helper is compiled from `host\ChessReviewHost.cs` at install time — `native\` is never shipped
  inside the browser extension packages.
