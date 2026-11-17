# Who is "you"?

The review page ("Your accuracy", your mistakes, practice) and the in-page button ("You played
with 91% accuracy") need to know which side of a game the user played. No single source is
reliable forever: site markup changes, people review friends' games, and new installs know
nothing. `lib/identity.js` therefore combines independent layers, resolved per site
(Chess.com and Lichess are learned separately).

| # | Layer | Where it comes from | Survives a markup change? |
|---|-------|---------------------|---------------------------|
| 1 | Signed-in account (live) | Content script reads the page now | No: this is the layer that breaks first |
| 2 | Typed handle (fork) | The username set in the popup ("Manual setup") or seeded from the page's POV player on first run | Yes: it is the user's own statement |
| 3 | Remembered sign-ins | Every page visit reports the signed-in name (`accountSeen` → `identity:v1`), kept 90 days, up to 5 per site | Yes: keeps working after detection breaks |
| 4 | Game history | The player who recurs across reviewed games (≥3 different opponents and ≥2 games ahead of the next name), from PGN headers only | Yes: uses no page markup at all |
| 5 | Verified bottom player | The bottom player's name block **and** the rendered board's orientation; if both are read they must agree | No |

## Resolution rules

1. A live signed-in account decides: if it is a player, that side is you; if not, it is not your game.
2. Otherwise a typed handle that played the game is you (this fork's popup username).
3. Otherwise the most recent remembered sign-in that played the game is you.
4. Otherwise the history player, if they played the game, is you.
5. If layers 2–4 know who you are and you are not in the game, it is **not your game**. The bottom
   player is never borrowed as "you" for a game you didn't play.
6. Only when nothing is known at all, the verified bottom player is you. A page that clearly shows
   you are signed out skips this step: a signed-out visitor is a spectator, and the bottom seat
   is just the site's default view.

The bottom player only counts when the page rendered it. URL hints (`?flip=`, `?username=`,
`/black`) and pasted links describe a perspective, not who is viewing, so they never establish
identity.

**Identity and orientation are independent.** The page's flip hint (or a `?flip=` link) decides
which way up the board is drawn; the resolved identity decides whose accuracy, categories and
saved review it is. `analysis.js` keeps them apart: `S.flipped` follows the hint while `S.meSide`
follows the identity, so a game shown from the opponent's side is still scored for you.

## Detection sources

Each site's content script reads its sources in order and reports which one succeeded (`via`):

- **Lichess** (`lichess-content.js`): `<body data-username>`, then the `#user_tag` header button,
  then `<body data-user>`. Bottom player: the `.ruser-bottom` profile link (`/@/name`), then
  Lichess's boot data for the viewer's colour when it matches the rendered orientation.
  Finished games open in the analysis view (`/game/<id>`), which has no bottom player block;
  there the main board's `orientation-white|black` class alone gives the bottom side.
- **Chess.com** (`content.js`): pages marked `<html class="user-logged-out">` are never read
  (signed-in pages carry `user-logged-in`). Otherwise the inline `context = {…}` boot object's
  `user.username` (still the signed-in user on other members' profile pages), then a single
  agreeing `/member/` link in the site navigation (`nav#sidebar-main-menu` today). The fallback
  never reads the board, players, chat, friends list or anything inside `<main>` (profile pages
  have their own `<nav>` of tabs linking to that member), and never accepts the member whose
  profile is open. Board orientation comes from the game board (`.board-layout-chessboard`,
  `#board-single`) before any other board on the page. Bottom player: the
  `.player-bottom` / `.board-layout-bottom` username, ignoring the "Player"/"Opponent" loading
  placeholders.

If a page clearly shows a signed-in user but no name could be read, the content script logs one
console warning naming the function to update. Layers 2–4 keep identification working in the
meantime.

## Where it is resolved

- `analysis.js` `main()` resolves the identity **before** `buildUI()`, so the first paint already
  seats the game (and `applyGame()` still runs with no await between it and `buildUI()`). The result
  is stamped on the payload as `meta.myName` / `meta.playerKnown` / `meta.identitySource`.
- `lib/button-preview-service.js` resolves it per request for the in-page preview card, which
  highlights "you" on both rows; the answer carries `me` (the side) and `meSource` (which layer).
- A payload that already carries `meta.myName` or `meta.playerKnown` (a share link, a saved review)
  keeps it: the resolver is skipped, exactly as `inferUsername()` does.
- `analyze-flow.js` forwards the page's `perspective` (`meta.perspective`) for both platforms.

## Privacy

Account names stay in `chrome.storage.local` (see `PRIVACY.md`). Share links strip the sender's
`perspective` and `identitySource`, in `shareGame()` and again in the background `openShared`
handler, so a recipient resolves their own identity.
