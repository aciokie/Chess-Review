# Chess Review — Agent Guide

## Project Overview
Browser extension (MV3) for Chess.com/Lichess game review with local Stockfish analysis.
Main entrypoints: `popup.html` → `analysis.html` (review UI), `content.js` / `lichess-content.js` (page integration), `background.js` (service worker).
Optional Windows native engine: `native/` (Native Messaging host + bundled official Stockfish 19 exe).

## Commands
```bash
npm ci                    # install deps
npm test                  # run all Node tests (jsdom + vm)
npm run lint              # web-ext lint (stages a hardened Firefox profile; skips native/)
npm run verify:engines    # verify bundled Stockfish WASM checksums
npm run build             # package Chrome + Firefox ZIPs + source snapshot to web-ext-artifacts/
npm run start:chrome      # run extension in Chromium (dev)
npm run start:firefox     # run extension in Firefox (dev)
npm run test:browsers     # real-browser smoke; honors CHROME_PATH / FIREFOX_PATH env vars
npm run test:native-host  # real-protocol test of the native host (Windows-only; skips elsewhere)
npm run update:dataset    # refresh the Lichess validation sample + lock (tools/calibration-experiments; not shipped)
node tools/calibration/reproduce-public.mjs   # offline replay of the public scoring models (no engine, no network)
```
Requires Node 22+ (CI pins 22). Verification order that works: `npm test` → `npm run lint` → `npm run verify:engines` → `npm run build`.

## Test Notes
- Tests in `tests/*.test.mjs` use Node's native test runner + JSDOM
- Helper `tests/helpers/app.mjs` loads `analysis.js` in a vm context, stubs browser APIs and `Engine`; inject extra globals via `a.context.X` (imports are stripped from analysis.js)
- One `tests/*.test.mjs` file = one suite (`npm test` globs them all; 45 suites cover app, concepts, native adapter, recent games, calibration)
- Run a single suite: `node --test tests/classification.test.mjs`
- Network code (`recent-games.js`) takes an injected `fetchImpl` — unit tests never touch the network
- `npm run test:browsers` reads `web-ext-artifacts/latest-release.json`, so it needs a prior `npm run build` (it drives the *packaged* extensions, not the working tree)

## Architecture
- **Single-file app logic**: `analysis.js` (~7000 lines) — state machine, classification, UI rendering, engine coordination
- **Launch flow**: `analyze-flow.js` `openAnalysisTab()` is shared by popup click and the `Ctrl+Shift+Y` shortcut; it stashes the game under a per-job UUID key (`job:<uuid>`) and opens `analysis.html#<uuid>` (a timestamp alone collides across same-ms launches)
- **Live board** (`analysis.html#live`, `meta.live`): a real game played on the review board. `livePlayMove()` appends each move to the mainline PGN, so the eval graph, accuracy, Elo and the three phase estimates all come from the normal `computeDerived()` path (no second scoring pipeline); a move from an earlier ply still opens a variation, i.e. review without ending the game. Resign / checkmate / draw calls `finishLive()`, which stamps `Result` and `meta.liveOver` and hands the PGN back to `applyGame()` so `startAnalysis()` + `saveToLibrary()` run exactly as for a fetched game. Live searches are uncalibrated, so a live accuracy/Elo can differ from the final public-scoring review on SF19 builds
- **WASM pool**: `engine/uci.js` wraps bundled Stockfish; `createEngine()` in analysis.js manages parallel workers
- **Native engine**: `engine/native.js` (`NativeEngine`, same contract as uci.js) ↔ `native/host/ChessReviewHost.exe` ↔ real Stockfish 19. Build key `native19` is only tried when the user selects it; native falls back DOWN to WASM (`nnue` → `sf19full` → `sf19lite`), never the reverse
- **Recent games**: `recent-games.js` pages through a user's games (30 per page via `createRecentGamesPager`; Lichess uses the export's `until`, Chess.com walks monthly archives) from the Lichess/Chess.com APIs by username (popup section "Recent games")
- **Game identity & caching**: `gameid.js` owns what makes two games "the same" (the platform's immutable id, else a PGN hash) and every `gamecache:` key; `gamecache.js` stores fetched PGNs locally (LRU-capped) so re-opening a seen game costs no API calls
- **Concepts pipeline**: `lib/concepts/` runs detectors off the UI thread in `worker.js`; `runtime.js` executes them by group, then `lib/coach-insights.js` (`coachInsights`/`coachReply`/`playerText`/`tidyText`) phrases the findings for the player. `controls.js` `CONCEPT_GROUPS` / `DEFAULT_CONCEPT_GROUPS` are implementation controls (cost-ordered, most heavy groups default off), not research acceptance
- **No build step for source** — extension loads raw JS/CSS; `npm run build` only packages for stores

## Key Files
| File | Purpose |
|------|---------|
| `analysis.js` | Core logic: PGN parse, engine pool, move classification, accuracy, UI |
| `styles.css` | All styling (CSS variables for themes, move quality colors) |
| `manifest.json` | MV3 hybrid Chrome/Firefox manifest; permissions incl. `nativeMessaging` |
| `engine/*.js/.wasm` | Bundled Stockfish 18 NNUE (default), 19 Full, 19 Lite |
| `recent-games.js` | Username → all games, paged (Lichess + Chess.com APIs) |
| `analyze-flow.js` | Popup/shortcut → resolve active game → open analysis tab |
| `gameid.js` | Single source of truth for game identity + every game-scoped cache key (platform id; PGN-hash fallback) |
| `gamecache.js` | Local PGN cache keyed by site + id (LRU-capped); re-analysis of a seen game costs 0 API calls |
| `browser-compat.js` | `browserAPI` Promise wrapper (Firefox `browser` → Chrome `chrome`); used across popup/analysis/tools |
| `progress.html`, `progress.js`, `lib/progress.js` | Engine-free Progress page (accuracy/rating trend, openings, per-phase accuracy, personal bests) + the **Data** tab (backup export/import); all math lives in `lib/progress.js` so Node can test it |
| `lib/library-backup.js` | Pure export/import of the local library + settings (`chess-review-backup` v1 JSON); merge is id-keyed with the newer `savedAt` winning |
| `lib/concepts/` | Concepts detectors + runtime (worker) + provenance |
| `lib/coach-insights.js` | Concept finding presentation (ordering, perspective swap, wording) |
| `native/` | Windows Native Messaging host (C# source; installer compiles it — no prebuilt exe is committed), bundled SF19 exe, installer, docs |
| `tools/calibration/` | Public scoring-model fitting + reproduction pipeline for `data/calibration.json` (never packaged) |
| `tools/calibration-experiments/` | The fork's earlier offline calibration pilot and dataset updater (never packaged) |
| `lib/move-grades.js`, `lib/game-statistics.js` | 0–10 per-move grade within a category; per-game statistics from scored decisions (annotations only) |
| `lib/public-scoring.js`, `lib/calibrated-review.js`, `lib/calibrated-search.js` | Per-engine accuracy/rating scoring: pure formulas, per-game scoring, and the search protocol that produces its observations |
| `data/calibration.json` / `data/calibration-legacy.json` | Public per-engine models (SF18 NNUE, SF19 family: Lite/Full/Native) / earlier tuned parameters used by non-default SF18 settings and by move classification |
| `data/book.json` | Opening book (EPD format) |
| `lib/chess.js` | Chess.js fork for move gen/validation |

## Concepts pipeline (lib/concepts)
- `lib/concepts/detectors/E*.mjs` are generated copies of the `research/` experiments; their bytes and a source fingerprint are recorded in `lib/concepts/integration-provenance.json`. **Do not hand-edit detectors.**
- Wording, scope phrasing and perspective belong in `lib/coach-insights.js`; `tests/concept-wording.test.mjs` exercises presentation on real detector output
- Neither `scripts/promote-concept-integration.mjs` (the generator) nor `research/` exists in this checkout, so the hash/fingerprint assertions in `tests/concept-integration.test.mjs` self-skip — an accidental detector edit will not be caught by tests here

## Progress page & backup (fork-native, not upstream)
- The Progress page reads only `browserAPI.storage.local["library"]`; per-phase accuracy and personal bests depend on records saved *after* `saveToLibrary` began writing `plies` + `myPhases`, so older records are skipped (the reports tolerate missing fields)
- `lib/library-backup.js` deliberately excludes the per-game analysis caches (`analysis:<id>`) and `gamecache:*` — they are large and rebuild on demand, keeping a 1000-game backup a few hundred KB

## Packaging & lint
- `scripts/package.mjs` uses an **explicit allowlist** — any new file that `popup.js`/`analysis.js` imports MUST be added or the store ZIPs break (this bit `recent-games.js`)
- `native/` goes into the **source snapshot only**, never the browser ZIPs; `scripts/lint.mjs` skips `native/`, `web-ext-artifacts/` and `calibration-runs/` for the same reason
- `manifest.version` must equal `package.json` `version` or the build throws

## CI (GitHub Actions)
- `.github/workflows/verify.yml` (ubuntu-24.04, Node 22) gates every push to `main` and every PR: `npm ci` → `npm test` → `npm run verify:engines` → `node tools/calibration/reproduce-public.mjs`. Changing `data/calibration.json` without regenerating the public models fails the offline replay
- `.github/workflows/native-engine.yml` (windows-latest) runs the full `npm test` + `node scripts/native-host-smoke.mjs`; on `v*` tags it compiles the helper and publishes `ChessReview-NativeEngine-Windows.zip` to Releases
- `.github/workflows/update-validation-dataset.yml` refreshes the Lichess validation sample monthly (commits `tools/calibration-experiments/dataset-lock.json`)

## Native engine (Windows)
- SF19 scoring family: `lib/scoring-builds.js` (`sf19lite`, `sf19full`, `native19`) — one protocol (fixed 20,000 nodes, Hash 32, UCI_ShowWDL, exact-only, restricted-move searches). Native needs host ≥ 1.1.0 (`hello.capabilities` contains `scoring-v1`); `S.nativeScoring === false` means an old helper and the legacy path. Never hard-code `sf19lite`; use `isSf19Build`
- Native helper source changes need a Windows build: no prebuilt `ChessReviewHost.exe` is committed for 1.1.0 (installer compiles from source; the release workflow records the built hash). Commit one + its hash in `native/host/checksums.json` when a Windows build is available
- Installer: `Install Native Engine.bat` (repo root) → `native/install.ps1` — defaults to the **bundled official SF19** (`native/engine/`, SHA-256 pinned automatically) and the **prebuilt helper** (`native/host/ChessReviewHost.exe`, hash in `native/host/checksums.json`); local csc compile is only a fallback. Unpack extension ids are auto-detected from browser profiles **at install time, so the unpacked extension must already be loaded when the installer runs**; reload the extension afterwards (it needs `nativeMessaging`)
- `native/README.md` section "Get a genuine Stockfish 19 executable" is stale prose: the installer now defaults to the bundled `native/engine/stockfish-windows-x86-64-universal.exe`
- Checksums pattern: `native/engine/checksums.json`, `native/host/checksums.json` — refresh the hash whenever a binary changes
- `csc.exe` (in-box .NET Framework 4.8) only speaks **C# 5**: no string interpolation, no `?.`, no `catch … when`
- **PowerShell 5.1 rules**: keep `.ps1` files pure ASCII + UTF-8 BOM (BOM-less files decode as ANSI and smart quotes inside strings break parsing); `New-Item -Force` fails on missing registry keys (guard with `Test-Path`); `Dictionary<K,V>` has no string `Contains()` — use `ContainsKey`
- Non-git installs update via `Update Extension.bat` → `update-extension.ps1` (diffs GitHub, downloads only changed files); it follows the same PS 5.1 rules

## Critical Patterns
- **State object `S`** in analysis.js holds all mutable state — search for `const S = {`
- **Classification thresholds** in `CALIB` object (winK, clsWp) — tests inject overrides
- **Engine builds**: `ENGINE_BUILDS` (WASM paths) + `NATIVE_BUILD = "native19"`; `isKnownEngineBuild()` gates migration and cache restore — native/WASM analysis caches are separate
- **CSS variables** for move quality: `--q-brilliant` through `--q-blunder` (Chess.com palette) plus `--q-forced` (light blue)
- **Forced** is a first-class category keyed off `_forcedAt(i)` = *exactly one legal move in the position before* (a board fact, no eval). `classifyMove` returns it before any eval logic, so a forced move can never be Brilliant/Great/Blunder. It is deliberately **badge-only**: `catAcc("forced")` scores 100 like Best and `move-grades.js` grades it 9 like Best (accuracy/ratings unchanged), and it is absent from `QBREAK_SUMMARY`/`QBREAK_FULL` (an extra row resizes the accuracy panel and shifts the saved desktop canvas). The best-move arrow stays suppressed on it, exactly as when it read as Best
- **Board frame** (`boardFrame` wood/accent + `coordsOutside`, Visual → Board / Pieces) is a *transparent `border`* on `.board` painted by a background gradient (`.board.framed` in styles.css), not a wrapper: absolutely positioned overlays (arrows, badges, promotion picker, the `.coords-out` labels) keep resolving against the padding box, so the playing area is unchanged and no layout rule had to move. Any code measuring the board for pointer/drag geometry must use `boardInner()` (the padding box) instead of `getBoundingClientRect()` on the whole element, or the frame is counted as squares

## Engine Verification
- WASM: `npm run verify:engines` checks SHA-256 in `engine/` against `engine/checksums.json`
- `engine/checksums.json` pins 6 files — SF18 NNUE (`stockfish-nnue.js/.wasm`), SF19 **Lite** (`stockfish-19-lite-single.js/.wasm`) and SF19 **Full** (`stockfish-19-single.js/.wasm`, build key `sf19full`). This pins the *committed bytes* only: it proves the working tree has not drifted from what was committed, **not** that those bytes came from the official Stockfish release
- `.gitattributes` keeps the engines byte-exact (`engine/stockfish*.js -text`, `engine/*.wasm binary`, `native/engine/*.exe binary`): never reformat, re-save or hand-regenerate an engine file, or the checksums stop matching
- Native: engine exe pinned in `native/engine/checksums.json` (auto-verified + hash-pinned at install); prebuilt helper pinned in `native/host/checksums.json`
- Bundled native engine is 98 MB — GitHub warns >50 MB (hard limit 100 MB); use Releases, not LFS, if it ever needs to move

## Testing in a real browser
- Unpacked extensions need `playwright-core` + `chromium.launchPersistentContext` with `--load-extension` — the Playwright MCP browser cannot load unpacked extensions
- `opencode.json` holds a `PLAYWRIGHT_MCP_EXTENSION_TOKEN` secret — never `git add` it (keep it ignored). It runs the Playwright MCP with `--extension` against the local **Brave** (`PLAYWRIGHT_MCP_EXECUTABLE_PATH`); that bridge controls your own browser, it does not launch one with `--load-extension`
- **Lichess 404s `HeadlessChrome` user agents** on its API — set a normal Chrome `userAgent` in the test context or live fetches fail with "user not found"
- MV3 service workers idle out (~30 s): seed storage through an extension **page** context, not a captured worker
- `npm run test:browsers` uses packaged ZIPs + isolated profiles; it falls back to `C:\Program Files\Google\Chrome\Application\chrome.exe` / `C:\Program Files\Mozilla Firefox\firefox.exe` unless `CHROME_PATH` / `FIREFOX_PATH` is set. Ad-hoc tests should use their own profile dir per run

## Workflow & environment
- This is a fork of `T-Julsgaard/Chess-Review` (the public upstream). `README.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/` and `.github/dependabot.yml` describe the upstream contribution flow
- Push verified changes straight to `main` (this repo's convention; no PR flow) and never push upstream
- When asked to *audit/check* something, stay read-only — report findings and wait for an explicit go-ahead before editing
- `git push` writes to stderr, so PowerShell reports exit code 1 even on success — verify the `old..new main -> main` line instead
- This machine runs Avast: freshly compiled exes get scanned (slow cold starts, occasional `EPERM` on `Process.Start` — the host already retries)
- Long `node -e "..."` one-liners get mangled by the shell here — write a temp `.cjs`/`.mjs`/`.ps1` script file instead
- Other sessions push to `main`; `git fetch`/pull before starting new work

## Gotchas
- Extension CSP requires `'wasm-unsafe-eval'` for Stockfish WASM
- Tests mock `Engine`/`NativeEngine` classes — real engines only run in a browser
- `analysis.js` has no exports; tests execute it in a vm context and access the `S` global
- No TypeScript, no bundler — plain ES modules
- Piece sets: only `cburnett` and `merida` are packaged (GPLv2+)
