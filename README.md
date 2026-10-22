# ♟ Chess Review

Free, open-source game review for your online chess games, powered by Stockfish NNUE running
locally in your browser. One click turns any **Chess.com** or **Lichess** game into a full
review — accuracy scores, move-by-move classifications, an evaluation graph, and an estimated
rating. No account, no server, no manual PGN copying.

The right-hand Settings panel includes an optional **Concepts** tab after Visual and
Engine. A separate **Concepts** panel to the right of Accuracy and Engine uses those
same findings, phrased from your playing side, with a **Coach reply** view that picks
the one most useful lesson for the selected move. Check **Enable concept analysis** to
list supported findings with their exact scopes. It defaults off and stops its worker
immediately when disabled. Existing scores and coach comments are unchanged.

**Source:** https://github.com/T-Julsgaard/Chess-Review

**Chrome webshop**: https://chromewebstore.google.com/detail/chess-review/pdbffcjdmcadihmnmenkadndbdbigfam?hl=en

**Firefox Add-ons**: https://addons.mozilla.org/en-US/firefox/addon/chess-review/

## Features

- **One-click review** of any Chess.com or Lichess game — or paste a game URL / raw PGN.
- **Accuracy estimates** for both players, calculated from local Stockfish analysis using the extension's scoring rules. Scores can differ from other review tools.
- **Accuracy by game phase**: each player's accuracy is also split into Opening (first 10 moves), Middlegame and Endgame (six or fewer knights, bishops, rooks and queens left), shown under the Elo estimate.
- **Move classifications** from Masterstroke to Blunder, with an evaluation graph and best-move arrows.
- **Estimated rating** — a rough guide to the level each player performed at in the game.
- **Opening detection** from an offline book, named even for PGNs without headers.
- **Explore board** from the popup, without loading a game: try legal moves, browse
  your move list, and see evaluations, opening names, and move ratings.
- **Rated alternatives** while reviewing a game, using the same classification rules
  as the played moves. Exploring does not change the original game or its accuracy.
- **Stockfish 18 NNUE is the default**, with **Stockfish 19 Lite** as a compact
  alternative. Both are bundled locally and available in Settings.
- **Optional native Stockfish 19 on Windows** — install the small per-user helper from
  [`native/`](native/README.md) and pick *Build: Stockfish 19 (Native)* to review with a native
  Stockfish 19 executable instead of WASM. Falls back to the bundled engines automatically.
- **Recoverable analysis errors** with a Retry button; unfinished reviews are not
  saved as completed games.
- **Analysis runs on your machine** — game lookup requests go directly to the chess platforms; no developer backend or analytics.

## Usage

1. Open a game on **Chess.com** or **Lichess**.
2. Click the extension icon → **Analyze this game**, or press `Ctrl+Shift+Y`.
3. The game opens in an analysis tab where Stockfish reviews every position.

No game open? Open the popup and type any **Lichess or Chess.com username** under **Recent games**
— it pulls that account's last 30 public games (from the official APIs); click one to review it.

For older games you don't have open, paste a game URL or PGN into the popup. Your username is
detected automatically from the board; if it can't be found, enter it once in the popup and it's
remembered.

To explore without a game, open the popup and select **Explore board**. Click or
drag pieces to make legal moves. Use the move list, arrow keys, or Home/End to
navigate. Making a different move replaces the continuation from that position.

The opening dictionary is bundled offline and has no automatic downloads.
Stockfish 19 Lite uses a smaller network than full Stockfish 19 and is not equivalent
in playing strength. The existing accuracy calibration was fitted to Stockfish 18
NNUE and has not been re-benchmarked for 19 Lite. Both builds use a single thread
per worker; the Workers setting already distributes positions across multiple workers.
The redundant Stockfish 10 and asm.js engines have been removed. Their saved
preferences migrate to 18; existing full-19 preferences migrate to 19 Lite.

### Native Stockfish 19 (Windows, optional)

Besides the bundled WASM builds, Windows users can review with a **native Stockfish 19 executable**
through a small per-user Native Messaging helper — see [`native/README.md`](native/README.md) for
download, one-command install, configuration, troubleshooting and uninstall. The helper is started by
the browser on demand, exits when the review is done, and always reaps its engine. If it is missing
or fails, reviews automatically use the bundled engines; the Engine tab always names the build that
is actually running, and cached reviews are never shared between native and WASM builds.

## Install

 `Packed`

Goto: https://chromewebstore.google.com/detail/chess-review/pdbffcjdmcadihmnmenkadndbdbigfam?hl=en

 `Unpacked`
1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.


## Privacy

Games are fetched from Chess.com's and Lichess's public APIs and analyzed locally
with bundled WebAssembly builds of Stockfish. Lookup requests include public player
usernames or game IDs. No games or analysis are sent to the developer or analytics services.
Firefox discloses the browsing activity and website content used for these requests.
Sharing a game copies an encoded, unencrypted PGN/metadata link to your clipboard;
anyone you send it to can read that information. See [PRIVACY.md](PRIVACY.md).

## Release packages

Run `npm ci`, `npm test`, `npm run verify:engines`, and `npm run build`.
The build creates separate Chrome and Firefox ZIPs under `web-ext-artifacts/`,
with browser-specific manifests and no development dependencies or tests. Each build
has its own release directory, source snapshot, and SHA-256 package checksums.
See [RELEASE.md](RELEASE.md) for store reviewer notes and validation commands.

## License & attributions

Chess Review's own code is licensed under the **GNU General Public License v3.0** (see
[`LICENSE`](LICENSE)), matching the bundled Stockfish engine. Bundled third-party assets (engine,
pieces, sounds, opening book, libraries) keep their own licenses — see
[`ATTRIBUTIONS.md`](ATTRIBUTIONS.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
Some asset redistribution rights remain unresolved as documented in the attributions;
the project's GPL license does not grant rights to those assets.
Corresponding source for the GPL/AGPL components is available
from the upstream projects listed there.

> **Disclaimer:** Chess Review is an independent, unofficial tool. It is **not affiliated with,
> endorsed by, or sponsored by Chess.com or Lichess**. Those names are used only to describe the
> sites it reads games from (nominative reference); all trademarks belong to their respective owners.
