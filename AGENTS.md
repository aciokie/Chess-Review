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
- `analysis.js` — Analysis page (≈4900 lines): PGN parsing, Stockfish analysis, UI rendering, accuracy calibration
- `content.js` — Chess.com content script: scrapes game ID, usernames, theme, board orientation
- `lichess-content.js` — Lichess content script: scrapes game ID, move list, board orientation
- `popup.html` / `popup.js` — Extension popup (manual URL/PGN entry, stored username)
- `engine/uci.js` — Stockfish worker wrapper (MultiPV, queue, handshake timeout)
- `engine/stockfish*.js/.wasm` — Bundled Stockfish NNUE (WASM)
- `lib/chess.js` — chess.js (PGN parsing, move generation)
- `data/book.json` — Opening book (EPD → ECO/name)
- `data/calibration.json` — Accuracy calibration params (win%-based scoring)
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

## Modifying Stockfish / Engine
- Engine files in `engine/` are pre-built WASM. To update: replace `stockfish-nnue.js/.wasm` (NNUE) or `stockfish.js/.wasm` (classic)
- `uci.js` constructor takes script/WASM paths; `analysis.js` tries NNUE first, falls back to classic on handshake failure
- Engine options (Hash, Skill Level) set via `engine.setOptions()` in `analysis.js`

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

## Upstream
- Source: https://github.com/T-Julsgaard/Chess-Review (this repo is a fork)
- Chrome Web Store: "Chess Review" (pdbffcjdmcadihmnmenkadndbdbigfam)