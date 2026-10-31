# ♟ Chess Review

**Fork of [T-Julsgaard/Chess-Review](https://github.com/T-Julsgaard/Chess-Review).**

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
- **Move classifications** from Brilliant to Blunder, with an evaluation graph and best-move arrows.
- **Forced-move badge**: a position with only one legal move is marked **Forced** rather than
  Best, Great or Brilliant, and it is left out of the accuracy breakdown — a forced move is not
  a decision, so it never changes your accuracy or rating.
- **Estimated rating** — a rough guide to the level each player performed at in the game.
- **Opening detection** from an offline book, named even for PGNs without headers.
- **Explore board** from the popup, without loading a game: try legal moves, browse
  your move list, and see evaluations, opening names, and move ratings.
- **Live board** from the popup: play or score a game on the analysis board while it is
  happening. Every move is added to the game, so the evaluation graph, accuracy, estimated
  rating and the three phase estimates update as you go; a move from an earlier position opens
  a normal variation. Each side has a **Resign** button — the other side wins, and the finished
  game is saved to your Library and fully analysed like any other review.
- **Rated alternatives** while reviewing a game, using the same classification rules
  as the played moves. Exploring does not change the original game or its accuracy.
- **Progress page** (open it from the popup): accuracy and estimated-rating trends across
  your saved games, accuracy split by game phase (opening, middlegame, endgame), an openings
  report that flags openings you score badly with, and personal bests. It is engine-free —
  it only reads your local Library.
- **Backup and restore** on the Progress page's **Data** tab: export your Library plus
  settings, handle, layout and account history to a JSON file, then import it later or on
  another PC — either merged (games matched by id, the newer copy wins) or as a replacement.
  The large per-game analysis caches are not included; they rebuild when a game is reopened.
- **Stockfish 18 NNUE is the default**; **Stockfish 19 Full** is the strongest bundled
  build and **Stockfish 19 Lite** a compact alternative. All three are bundled locally
  and selectable in Settings → Engine.
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
— it pulls that account's public games (from the official APIs) 30 at a time, newest first, with a "Load more games" button at the bottom until the account has no more; click one to review it. Each row shows the result, players, date, time control, move count and opening.

For older games you don't have open, paste a game URL or PGN into the popup. Your username is
detected automatically from the board; if it can't be found, enter it once in the popup and it's
remembered.

To explore without a game, open the popup and select **Explore board**. Click or
drag pieces to make legal moves. Use the move list, arrow keys, or Home/End to
navigate. Making a different move replaces the continuation from that position.

The opening dictionary is bundled offline and has no automatic downloads.
Stockfish 19 Lite uses a smaller network than full Stockfish 19 and is not equivalent
in playing strength. Both builds use a single thread per worker; the Workers setting
already distributes positions across multiple workers.

#### Scoring models

Accuracy and estimated rating come from **public, per-engine models** (`data/calibration.json`,
fitted by the reproducible pipeline in `tools/calibration`):

| Build | Search used for scoring | Accuracy / rating |
|-------|-------------------------|-------------------|
| Stockfish 18 NNUE (default) | depth 16, Hash 16 MB, full strength, 1 line | Public SF18 model |
| Stockfish 19 Lite, Stockfish 19 Full, Stockfish 19 (Native) | fixed 20,000 nodes, Hash 32 MB, full strength, one thread | Public SF19 model (identical logic for all three) |
| Stockfish 18 NNUE with non-default depth/hash/skill/lines | your settings | Earlier accuracy/rating estimate (`data/calibration-legacy.json`) |

All Stockfish 19 builds run the same fixed-node protocol, so depth/hash/strength settings only affect the
live engine panel for them. The SF19 accuracy curve (Lichess's public winning-chance curve) does not depend on
which SF19 build searched. The SF19 *rating* models were fitted from Stockfish 19 **Lite** observations; Full and
Native use them as-is, so their rating estimate is not separately calibrated. Scored native reviews need
native helper 1.1 or newer (re-run `Install Native Engine.bat`); an older helper keeps working with the
earlier estimate and the Engine tab says so.

Settings → Engine → **Rating estimate** offers **Use recorded rating** (compares you with
public players near the rating saved in the game) and **Moves only** (ignores that rating).
Without a saved rating the review falls back to Moves only, which needs at least ten
non-forced decisions. Move categories are annotations and never change accuracy or rating.
Categories are judged on expected points from one root search per move (best and played move scored
together). Brilliant and Great follow the upstream rules (a lasting, sound piece offer; the only good
reply); in a won position they need a runner-up line, so raise **Analysis lines** to 2 to enable them
there. Each move also shows a 0–10 score within its category, and completed reviews list top-move match,
average loss and other game statistics. See [`docs/MOVE_CLASSIFICATION.md`](docs/MOVE_CLASSIFICATION.md).
To reproduce the bundled coefficients offline (Node.js 22 or later), run
`node tools/calibration/reproduce-public.mjs`; the method is in
[`tools/calibration/PUBLIC_METHOD.md`](tools/calibration/PUBLIC_METHOD.md). Estimated
ratings are approximate, and scores can differ from other review tools.
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
