# Chess Review — Agent Guide

## Project Overview
Browser extension (MV3) for Chess.com/Lichess game review with local Stockfish analysis.
Main entrypoints: `popup.html` → `analysis.html` (review UI), `content.js` / `lichess-content.js` (page integration), `background.js` (service worker).
Optional Windows native engine: `native/` (Native Messaging host + bundled official Stockfish 19 exe).

## Commands
```bash
npm ci                    # install deps
npm test                  # run all Node tests (jsdom + vm)
npm run verify:engines    # verify bundled Stockfish WASM checksums
npm run lint              # web-ext lint (stages a Firefox profile; skips native/)
npm run build             # package Chrome + Firefox ZIPs + source snapshot to web-ext-artifacts/
npm run test:native-host  # real-protocol test of the native host (Windows-only; skips elsewhere)
npm run start:chrome      # run extension in Chromium (dev)
npm run start:firefox     # run extension in Firefox (dev)
```
Verification order that works: `npm test` → `npm run lint` → `npm run verify:engines` → `npm run build`.

## Test Notes
- Tests in `tests/*.test.mjs` use Node's native test runner + JSDOM
- Helper `tests/helpers/app.mjs` loads `analysis.js` in a vm context, stubs browser APIs and `Engine`; inject extra globals via `a.context.X` (imports are stripped from analysis.js)
- Run single test: `node --test tests/classification.test.mjs`
- Network code (`recent-games.js`) takes an injected `fetchImpl` — unit tests never touch the network
- `tests/native-engine.test.mjs` (adapter) and `tests/recent-games.test.mjs` (username → game list) are the newest suites

## Architecture
- **Single-file app logic**: `analysis.js` (6000+ lines) — state machine, classification, UI rendering, engine coordination
- **WASM pool**: `engine/uci.js` wraps bundled Stockfish; `createEngine()` in analysis.js manages parallel workers
- **Native engine**: `engine/native.js` (`NativeEngine`, same contract as uci.js) ↔ `native/host/ChessReviewHost.exe` ↔ real Stockfish 19. Build key `native19` is only tried when the user selects it; native falls back DOWN to WASM (`nnue` → `sf19full` → `sf19lite`), never the reverse
- **Recent games**: `recent-games.js` fetches a user's last 30 games from the Lichess/Chess.com APIs by username (popup section "Recent games")
- **No build step for source** — extension loads raw JS/CSS; `npm run build` only packages for stores

## Key Files
| File | Purpose |
|------|---------|
| `analysis.js` | Core logic: PGN parse, engine pool, move classification, accuracy, UI |
| `styles.css` | All styling (CSS variables for themes, move quality colors) |
| `manifest.json` | MV3 hybrid Chrome/Firefox manifest; permissions incl. `nativeMessaging` |
| `engine/*.js/.wasm` | Bundled Stockfish 18 NNUE (default), 19 Full, 19 Lite |
| `recent-games.js` | Username → last 30 games (Lichess + Chess.com APIs) |
| `native/` | Windows Native Messaging host (C# source + prebuilt exe), bundled SF19 exe, installer, docs |
| `data/book.json` | Opening book (EPD format) |
| `lib/chess.js` | Chess.js fork for move gen/validation |

## Packaging & lint
- `scripts/package.mjs` uses an **explicit allowlist** — any new file that `popup.js`/`analysis.js` imports MUST be added or the store ZIPs break (this bit `recent-games.js`)
- `native/` goes into the **source snapshot only**, never the browser ZIPs; `scripts/lint.mjs` skips `native/` for the same reason

## Native engine (Windows)
- Installer: `Install Native Engine.bat` (repo root) → `native/install.ps1` — defaults to the **bundled official SF19** (`native/engine/`, SHA-256 pinned automatically) and the **prebuilt helper** (`native/host/ChessReviewHost.exe`, hash in `native/host/checksums.json`); local csc compile is only a fallback. Unpack extension ids are auto-detected from browser profiles
- Checksums pattern: `native/engine/checksums.json`, `native/host/checksums.json` — refresh the hash whenever a binary changes
- `.github/workflows/native-engine.yml`: windows-latest runs npm test + the native smoke test on push; on `v*` tags publishes `ChessReview-NativeEngine-Windows.zip` to Releases
- `csc.exe` (in-box .NET Framework 4.8) only speaks **C# 5**: no string interpolation, no `?.`, no `catch … when`
- **PowerShell 5.1 rules**: keep `.ps1` files pure ASCII + UTF-8 BOM (BOM-less files decode as ANSI and smart quotes inside strings break parsing); `New-Item -Force` fails on missing registry keys (guard with `Test-Path`); `Dictionary<K,V>` has no string `Contains()` — use `ContainsKey`

## Critical Patterns
- **State object `S`** in analysis.js holds all mutable state — search for `const S = {`
- **Classification thresholds** in `CALIB` object (winK, clsWp) — tests inject overrides
- **Engine builds**: `ENGINE_BUILDS` (WASM paths) + `NATIVE_BUILD = "native19"`; `isKnownEngineBuild()` gates migration and cache restore — native/WASM analysis caches are separate
- **CSS variables** for move quality: `--q-brilliant` through `--q-blunder` (Chess.com palette)

## Engine Verification
- WASM: `npm run verify:engines` checks SHA-256 in `engine/` against `engine/checksums.json`
- Native: engine exe pinned in `native/engine/checksums.json` (auto-verified + hash-pinned at install); prebuilt helper pinned in `native/host/checksums.json`
- Bundled native engine is 98 MB — GitHub warns >50 MB (hard limit 100 MB); use Releases, not LFS, if it ever needs to move

## Testing in a real browser
- Unpacked extensions need `playwright-core` + `chromium.launchPersistentContext` with `--load-extension` — the Playwright MCP browser cannot load unpacked extensions
- **Lichess 404s `HeadlessChrome` user agents** on its API — set a normal Chrome `userAgent` in the test context or live fetches fail with "user not found"
- MV3 service workers idle out (~30 s): seed storage through an extension **page** context, not a captured worker
- `npm run test:browsers` uses packaged ZIPs + isolated profiles; ad-hoc tests should use their own profile dir per run

## Workflow & environment
- Push verified changes straight to `main` (this repo's convention; no PR flow)
- When asked to *audit/check* something, stay read-only — report findings and wait for an explicit go-ahead before editing
- This machine runs Avast: freshly compiled exes get scanned (slow cold starts, occasional `EPERM` on `Process.Start` — the host already retries)
- Long `node -e "…"` one-liners get mangled by the shell here — write a temp `.cjs`/`.ps1` script file instead

## Gotchas
- Extension CSP requires `'wasm-unsafe-eval'` for Stockfish WASM
- Tests mock `Engine`/`NativeEngine` classes — real engines only run in a browser
- `analysis.js` has no exports; tests execute it in a vm context and access the `S` global
- No TypeScript, no bundler — plain ES modules
- Piece sets: only `cburnett` and `merida` are packaged (GPLv2+)
