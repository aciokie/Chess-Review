# Chess Review — Agent Notes

## Project Type
Vanilla JS Chrome Extension (Manifest V3). **No build tools, no package.json, no test framework, no linting.** Pure client-side code.

## Load the Extension (only "command")
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select `Chess-Review/` folder

## Architecture / Entry Points
- `manifest.json` — MV3 config (service worker, content scripts, popup, permissions)
- `background.js` — Service worker: handles `Ctrl+Shift+Y` shortcut, in-page "Free game review" button, shared game links
- `analyze-flow.js` — Core logic: finds game on active tab, fetches PGN, opens analysis tab
- `analysis.js` — Analysis page (~5140 lines): PGN parsing, Stockfish analysis, UI rendering, accuracy calibration, move classification, engine line arrows
- `content.js` — Chess.com content script: scrapes game ID, usernames, theme, board orientation
- `lichess-content.js` — Lichess content script: scrapes game ID, move list, board orientation
- `popup.html` / `popup.js` — Extension popup (manual URL/PGN entry, stored username)
- `engine/uci.js` — Stockfish worker wrapper (MultiPV, queue, handshake timeout, search timeout, terminate-with-reject)
- `engine/stockfish*.js/.wasm` — Bundled Stockfish NNUE (WASM)
- `lib/chess.js` — chess.js (PGN parsing, move generation)
- `data/book.json` — Opening book (EPD → ECO/name)
- `data/calibration.json` — Accuracy calibration params (win%-based scoring)
- `data/coaches/` — Coach personality definitions (JSON)
- `flags.js` — Country flag SVGs

## Key Conventions
- **ES Modules** everywhere (`type: "module"` in manifest, `import`/`export` in all JS)
- **Service worker** is the background; no persistent background page
- **Content scripts** run at `document_idle` on chess.com / lichess.org
- **Storage**: `chrome.storage.local` for username, cached games (`job:<timestamp>`), pending errors
- **No username →** prompt in popup; detected usernames from page used as fallback candidates
- **CSP**: `'wasm-unsafe-eval'` required for Stockfish WASM

## Data Flow (One-Click Review)
1. User clicks extension icon / presses `Ctrl+Shift+Y`
2. `background.js` → `analyzeActiveTab(username)` in `analyze-flow.js`
3. Content script (`content.js` or `lichess-content.js`) returns `{ gameId, usernames[], flip, theme, site }`
4. Chess.com: `findGameById()` searches candidate usernames' archives (cache-first, then current/prev month, then serial)
5. Lichess: `fetchLichessPgn(gameId)` from public export API
6. `openAnalysisTab({ pgn, meta, source, theme })` saves payload to `chrome.storage.local` + opens `analysis.html#jobId`
7. `analysis.js` loads PGN, runs Stockfish per position, renders eval graph, accuracy, classifications

## Engine / Stockfish
- Engine files in `engine/` are pre-built WASM. Sizes: stockfish-nnue.wasm (7.3MB), stockfish.js (62KB), stockfish.wasm (367KB), stockfish.asm.js (958KB)
- `uci.js` constructor takes script/WASM paths; `analysis.js` tries NNUE first, falls back to classic on handshake failure
- Engine options (Hash, Skill Level) set via `engine.setOptions()` in `analysis.js`
- **NNUE hash format** (important): NNUE builds need `#<encodedWasmUrl>,worker` hash to enter worker context. Classic SF10 uses plain `#<wasmUrl>`. This is handled in `uci.js` constructor.
- **Search timeout**: 60s per position — if `bestmove` never arrives, sends `stop` to prevent batch freeze
- **`terminate()` rejects pending jobs** so callers (`Promise.all`) don't hang forever

## Batch Analysis Error Handling
- Worker loop wraps `eng.analyse()` in try/catch — one bad position skips and keeps the worker alive
- `Promise.all` in `startAnalysis()` wrapped in try/catch — cleanup always runs (`terminateEngines()`, `S.analyzing = false`, `renderReview()`, `saveToLibrary()`)
- `requestLiveEval()` wraps `createEngine()` in try/catch
- Detailed `[Chess Review]` prefixed console logs for engine init, errors, and timeouts

## Move Classification
- `classifyVariationMove()` in `analysis.js` — classifies moves as book/best/forced/brilliant/excellent/good/inaccuracy/mistake/miss/blunder
- Classification badges shown on destination squares via `paintBoard()` (toggle: `showMoveClassif` setting)
- Engine panel header shows "Your move: [Badge]" in analysis mode

## Engine Line Arrows (Lichess-style)
- `renderEngineArrows()` draws one arrow per engine line on the board
- Best move = thickest green arrow; alternate lines = thinner blue arrows (60%, 40%, 25% thickness)
- Toggle: Settings → Best-move arrow → "Show engine line arrows"
- SVG overlay at z-index 7 (under single best-move arrow at z-index 8)

## Accuracy Calibration
- `data/calibration.json` produced by external tooling (`tools/dataset/export-calibration.mjs` in upstream)
- If present with `display: "winpct"`, shown accuracy uses tuned win%-based method
- Safe to delete → falls back to original category-average method

## Opening Book
- `data/book.json` built from `lichess-org/chess-openings` (see upstream `data/build-book.mjs`)
- Key = EPD (first 4 FEN fields) → `[eco, name]` or `0` (known unnamed)
- `analysis.js:bookLookup()` used for opening naming + "Book" move classification

## Common Gotchas
- **GAME_ID_RE** in `chesscom.js` AND `content.js` must stay in sync (URL scheme changes break game detection)
- Content script may be stale after extension reload → `analyze-flow.js` re-parses URL directly as fallback
- Chess.com SPA often hasn't exposed just-finished game URL → `reloadActiveAndAnalyze()` retries once after reload + 900ms settle
- No tests exist; verify manually on chess.com / lichess game pages
- No lint/typecheck; syntax errors only caught at runtime in browser console
- **PowerShell**: Use `;` not `&&` as statement separator (Windows PowerShell 5.1 doesn't support `&&`)

## Upstream
- Source: https://github.com/T-Julsgaard/Chess-Review (this repo is a fork)
- Chrome Web Store: "Chess Review" (pdbffcjdmcadihmnmenkadndbdbigfam)