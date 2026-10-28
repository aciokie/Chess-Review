// recent-games.js — pull a user's latest games from Lichess or Chess.com by username.
//
// Both platforms expose public, key-less APIs that the extension already has host permissions for:
//   Lichess    GET https://lichess.org/api/games/user/{user}?max=N   (Accept: application/x-chess-pgn)
//   Chess.com  GET https://api.chess.com/pub/player/{user}/games/archives → monthly archive URLs
// The popup renders the list; clicking a game reviews it through the normal analysis flow.
//
// Everything here is injectable-fetch based, so tests run with real Response objects and no network.

import { parseGameId, gameMeta } from "./chesscom.js";

export const RECENT_MAX = 30;

const LICHESS_SITE = "https://lichess.org";
const CHESSCOM_API = "https://api.chess.com/pub";

/* ---------------- username validation ---------------- */

export function isValidUsername(username, site) {
  const name = String(username || "").trim();
  if (site === "lichess") return /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,24}$/.test(name);
  if (site === "chesscom") return /^[a-zA-Z0-9_-]{3,25}$/.test(name);
  return false;
}

/* ---------------- game details shown in the list ---------------- */

/**
 * Full-move count of a PGN ("34" for a game that ended after 34 moves, even if Black's last move
 * is missing). Headers, {comments}, (variations), $NAGs, move numbers and the result are ignored.
 */
export function countMoves(pgn) {
  let text = String(pgn || "").replace(/^\s*\[[^\]]*\]\s*$/gm, " ");
  text = text.replace(/\{[^}]*\}/g, " ").replace(/;[^\n]*/g, " ");
  for (let prev = ""; prev !== text;) { prev = text; text = text.replace(/\([^()]*\)/g, " "); }
  const plies = text.replace(/\$\d+/g, " ").replace(/\d+\.(\.\.)?/g, " ")
    .split(/\s+/).filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|½-½|\*)$/.test(t)).length;
  return Math.ceil(plies / 2);
}

/** "600" → "10 min", "180+2" → "3+2", "30" → "30 s", "1/86400" (daily) → "Daily", "-" → "". */
export function formatTimeControl(tc) {
  const raw = String(tc || "").trim();
  if (!raw || raw === "-" || raw === "?") return "";
  if (raw.includes("/")) return "Daily";
  const [baseText, incText] = raw.split("+");
  const base = Number.parseInt(baseText, 10);
  if (!Number.isFinite(base) || base <= 0) return "";
  const inc = Number.parseInt(incText, 10);
  const mins = +(base / 60).toFixed(2);
  if (Number.isFinite(inc) && inc > 0) return `${mins}+${inc}`;
  return base >= 60 ? `${mins} min` : `${base} s`;
}

// The Chess.com URL slug drops hyphens and apostrophes; put back the ones in common opening names.
const OPENING_FIXES = [
  [/\bCaro Kann\b/g, "Caro-Kann"], [/\bNimzo Indian\b/g, "Nimzo-Indian"], [/\bBogo Indian\b/g, "Bogo-Indian"],
  [/\bKings\b/g, "King's"], [/\bQueens\b/g, "Queen's"], [/\bPetrovs\b/g, "Petrov's"],
  [/\bAlekhines\b/g, "Alekhine's"], [/\bPhilidors\b/g, "Philidor's"], [/\bBirds\b/g, "Bird's"],
];
function restoreOpeningPunctuation(name) {
  return OPENING_FIXES.reduce((out, [re, fix]) => out.replace(re, fix), name);
}

/**
 * Chess.com's PGN carries [ECO "B12"] and [ECOUrl ".../openings/Caro-Kann-Defense-Advance-Variation-3...c5-4.Nf3"].
 * The URL slug is the opening name followed by the moves that reached it, so cut it at the first move.
 */
export function chessComOpening(pgn) {
  const url = pgnHeader(pgn, "ECOUrl");
  const slug = decodeURIComponent((url.split("/openings/")[1] || "").split(/[?#]/)[0] || "");
  const words = slug.split("-").filter(Boolean);
  const cut = words.findIndex((w) => /^\d+\.{1,3}/.test(w));
  const name = restoreOpeningPunctuation((cut === -1 ? words : words.slice(0, cut)).join(" ").trim());
  return { eco: pgnHeader(pgn, "ECO"), name };
}

/** The extra lines the popup shows under a game: { meta: "blitz 3+0 | 34 moves", opening: "B12 Caro-Kann …" }. */
export function describeDetails(entry) {
  const tc = entry.timeControl ? ` ${entry.timeControl}` : "";
  const moves = entry.moves ? `${entry.moves} ${entry.moves === 1 ? "move" : "moves"}` : "";
  const klass = entry.timeClass && entry.timeClass !== "unknown" ? `${entry.timeClass}${tc}` : tc.trim();
  const opening = entry.opening ? [entry.eco, entry.opening].filter(Boolean).join(" ") : "";
  return { meta: [klass, moves].filter(Boolean).join(" | "), opening };
}

/* ---------------- Lichess ---------------- */

/** Split a multi-game PGN export into individual PGN strings (headers + movetext blocks). */
export function splitMultiGamePgn(text) {
  const games = [];
  let current = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^\s*\[Event\s+"/.test(line) && current.length) {
      games.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) games.push(current.join("\n").trim());
  return games.filter((g) => g && /\[\s*\w+\s+"/.test(g));
}

/** True for ordinary chess: no Variant tag, "Standard", "Chess" or "From Position". */
export function isStandardVariant(name) {
  const v = String(name || "").trim();
  return !v || /^(standard|chess|from position)$/i.test(v);
}

/** Read one header tag from a single-game PGN. */
export function pgnHeader(pgn, tag) {
  const m = new RegExp(`^\\s*\\[${tag}\\s+"([^"]*)"\\]`, "m").exec(pgn || "");
  return m ? m[1] : "";
}

/**
 * Lichess time control string → coarse class. Lichess classifies by ESTIMATED duration, which is the
 * base time plus 40 moves of increment — so 5+5 (500 s) is Rapid and 2+2 (200 s) is Blitz, not
 * Blitz and Bullet as the base time alone would say.
 */
export function timeClassFromLichessTimeControl(tc) {
  const raw = String(tc || "").trim();
  if (!raw || raw === "-") return "unlimited";
  const [baseText, incText] = raw.split("+");
  const base = Number.parseInt(baseText, 10);
  if (!Number.isFinite(base)) return "unknown";
  const increment = Number.parseInt(incText, 10);
  const estimated = base + 40 * (Number.isFinite(increment) && increment > 0 ? increment : 0);
  if (estimated < 180) return "bullet";
  if (estimated < 480) return "blitz";
  if (estimated < 1500) return "rapid";
  return "classical";
}

/** One Lichess PGN (with headers) → a list entry, or null when it has no usable identity. */
export function lichessGameToEntry(pgn) {
  const site = pgnHeader(pgn, "Site");
  const gameId = (parseLichessSiteId(site) || pgnHeader(pgn, "GameId") || "").slice(0, 8);
  if (!gameId) return null;
  if (!isStandardVariant(pgnHeader(pgn, "Variant"))) return null; // the analyzer only handles standard chess
  const date = pgnHeader(pgn, "UTCDate");
  const time = pgnHeader(pgn, "UTCTime");
  const playedAt = /^\d{4}\.\d{2}\.\d{2}$/.test(date)
    ? new Date(`${date.replace(/\./g, "-")}T${time || "00:00:00"}Z`).toISOString()
    : "";
  return {
    source: "lichess",
    pgn,
    gameId,
    url: `https://lichess.org/${gameId}`,
    white: pgnHeader(pgn, "White"),
    black: pgnHeader(pgn, "Black"),
    whiteElo: Number.parseInt(pgnHeader(pgn, "WhiteElo"), 10) || null,
    blackElo: Number.parseInt(pgnHeader(pgn, "BlackElo"), 10) || null,
    result: pgnHeader(pgn, "Result") || "?",
    playedAt,
    timeClass: timeClassFromLichessTimeControl(pgnHeader(pgn, "TimeControl")),
    timeControl: formatTimeControl(pgnHeader(pgn, "TimeControl")),
    moves: countMoves(pgn),
    opening: pgnHeader(pgn, "Opening"),
    eco: pgnHeader(pgn, "ECO"),
    rated: pgnHeader(pgn, "Rated") === "1",
  };
}

/** Lichess puts the game URL in [Site "https://lichess.org/xxxx"]. */
function parseLichessSiteId(site) {
  if (!site) return "";
  try { return new URL(site, LICHESS_SITE).pathname.replace(/^\/+/, "").split(/[/?#]/)[0] || ""; }
  catch { return ""; }
}

/** Time a Lichess PGN says the game started, in ms (second precision), or 0 when it has no usable date. */
function lichessPgnMs(pgn) {
  const date = pgnHeader(pgn, "UTCDate");
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) return 0;
  const ms = Date.parse(`${date.replace(/\./g, "-")}T${pgnHeader(pgn, "UTCTime") || "00:00:00"}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * One request to the Lichess bulk PGN export: up to `max` games, newest first, optionally only games
 * started before `until` (ms). Clocks/evals are off so the movetext stays clean for the analyzer.
 * Returns the raw PGNs too, because the caller pages by the OLDEST raw game even when that one is
 * not reviewable (variants are dropped from `entries` but still count as "a page was full").
 */
async function fetchLichessPage(username, { max, until = null, fetchImpl }) {
  const untilParam = until ? `&until=${until}` : "";
  const url = `${LICHESS_SITE}/api/games/user/${encodeURIComponent(username.trim())}?max=${max}${untilParam}&clocks=false&evals=false&literate=false&opening=true&perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence`; // perfType = standard chess only (variants have their own perf types)
  const res = await fetchImpl(url, { headers: { Accept: "application/x-chess-pgn" } });
  if (res.status === 404) throw new Error("Lichess user not found (or no public games).");
  if (res.status === 429) throw new Error("Lichess rate-limited the request — try again in a minute.");
  if (!res.ok) throw new Error(`Lichess returned HTTP ${res.status}.`);
  const pgns = splitMultiGamePgn(await res.text());
  return { pgns, entries: pgns.map(lichessGameToEntry).filter(Boolean) };
}

/** The latest games of a Lichess user, newest first (one page; see createRecentGamesPager for more). */
export async function fetchLichessRecentGames(username, { max = RECENT_MAX, fetchImpl = fetch } = {}) {
  const { entries } = await fetchLichessPage(username, { max, fetchImpl });
  return sortByNewest(entries).slice(0, max);
}

/* ---------------- Chess.com ---------------- */

/** Chess.com reports each player's result string; only "win" names the winner. */
export function chessComResult(whiteResult, blackResult) {
  if (whiteResult === "win") return "1-0";
  if (blackResult === "win") return "0-1";
  if (whiteResult || blackResult) return "½-½";
  return "?";
}

/** One Chess.com API game object → a list entry shaped like the Lichess ones. */
export function chessComGameToEntry(game) {
  if (!game || !game.pgn) return null;
  // `rules` is "chess" for standard games; chess960, bughouse, crazyhouse … are not reviewable.
  if (game.rules && game.rules !== "chess") return null;
  if (!isStandardVariant(pgnHeader(game.pgn, "Variant"))) return null;
  const url = game.url || "";
  const op = chessComOpening(game.pgn);
  return {
    source: "chesscom",
    pgn: game.pgn,
    gameId: parseGameId(url)?.id || url,
    url,
    white: game.white?.username || "?",
    black: game.black?.username || "?",
    whiteElo: Number(game.white?.rating) || null,
    blackElo: Number(game.black?.rating) || null,
    result: chessComResult(game.white?.result, game.black?.result),
    playedAt: game.end_time ? new Date(game.end_time * 1000).toISOString() : "",
    timeClass: game.time_class || "unknown",
    timeControl: formatTimeControl(game.time_control),
    moves: countMoves(game.pgn),
    opening: op.name,
    eco: op.eco,
    rated: game.rated !== false,
    raw: game, // the popup passes this to gameMeta() for the review payload
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJsonWithRetry(url, fetchImpl) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 404) throw new Error("Chess.com user not found (or no public games).");
    if (res.status === 429) throw new Error("Chess.com rate-limited the request — try again in a minute.");
    if ((res.status === 500 || res.status >= 502) && attempt < 2) { await sleep(700 * (attempt + 1)); continue; }
    throw new Error(`Chess.com returned HTTP ${res.status}.`);
  }
}

/**
 * The latest games of a Chess.com user, newest first. Chess.com exposes games per month, so walk
 * the archive index newest → oldest (serially — Chess.com asks for that) until `max` are collected.
 */
export async function fetchChessComRecentGames(username, { max = RECENT_MAX, fetchImpl = fetch } = {}) {
  const user = encodeURIComponent(username.trim().toLowerCase());
  const data = await fetchJsonWithRetry(`${CHESSCOM_API}/player/${user}/games/archives`, fetchImpl);
  const archives = (data.archives || []).slice().reverse(); // newest month first
  const entries = [];
  for (const archiveUrl of archives) {
    if (entries.length >= max) break;
    const month = await fetchJsonWithRetry(archiveUrl, fetchImpl);
    const games = (month.games || []).slice().reverse(); // within a month: oldest → newest
    for (const game of games) {
      if (entries.length >= max) break;
      const entry = chessComGameToEntry(game);
      if (entry) entries.push(entry);
    }
  }
  return sortByNewest(entries).slice(0, max);
}

/* ---------------- paging: "Load more" until the user runs out of games ---------------- */

/**
 * Pages through ALL of a user's games, newest first, `pageSize` at a time:
 *   const pager = createRecentGamesPager("ana", "lichess");
 *   const { games, done } = await pager.loadMore();   // first page
 *   if (!done) await pager.loadMore();                // the next, older page … until done
 * Lichess pages with the export's `until` timestamp; Chess.com walks its monthly archives. Calls
 * made while one is in flight share that request, and a finished pager just returns done.
 */
export function createRecentGamesPager(username, site, { pageSize = RECENT_MAX, fetchImpl = fetch } = {}) {
  const name = String(username || "").trim();
  if (!name) throw new Error("Type a username first.");
  if (!isValidUsername(name, site)) throw new Error(`That doesn't look like a valid ${site === "lichess" ? "Lichess" : "Chess.com"} username.`);
  const lichess = site === "lichess";
  const seen = new Set();
  let done = false, inflight = null, total = 0;
  // Lichess cursor
  let until = null;
  // Chess.com cursor
  let archives = null, monthIdx = 0, buffer = [];

  async function lichessPageOfGames() {
    // A little headroom: `until` is inclusive of the whole second, so the previous page's oldest
    // game(s) can come back and are dropped by the `seen` set below.
    const want = pageSize + (until ? 5 : 0);
    const { pgns, entries } = await fetchLichessPage(name, { max: want, until, fetchImpl });
    const fresh = sortByNewest(entries).filter((e) => !seen.has(e.gameId));
    if (pgns.length < want) done = true;                       // the export ran dry
    else {
      const oldest = Math.min(...pgns.map(lichessPgnMs).filter(Boolean));
      if (!Number.isFinite(oldest)) done = true;
      else {
        let next = (Math.floor(oldest / 1000) + 1) * 1000 - 1;   // include the oldest game's whole second
        if (until && next >= until) next = until - 1000;         // a full page of one second → still make progress
        until = next;
      }
    }
    return fresh;
  }

  async function chessComPageOfGames() {
    if (!archives) {
      const data = await fetchJsonWithRetry(`${CHESSCOM_API}/player/${encodeURIComponent(name.toLowerCase())}/games/archives`, fetchImpl);
      archives = (data.archives || []).slice().reverse();      // newest month first
    }
    while (buffer.length < pageSize && monthIdx < archives.length) {
      const month = await fetchJsonWithRetry(archives[monthIdx], fetchImpl);
      monthIdx++;                                              // only after the month loaded, so a failure retries it
      buffer.push(...sortByNewest((month.games || []).map(chessComGameToEntry).filter(Boolean)));
    }
    const page = buffer.splice(0, pageSize);
    if (monthIdx >= archives.length && !buffer.length) done = true;
    return page;
  }

  async function run() {
    // A page can come back with nothing new (e.g. only already-seen games near a boundary) while
    // more exist further back — keep going a few times rather than showing an empty "page".
    let games = [];
    for (let attempt = 0; attempt < 5 && !games.length && !(attempt && done); attempt++) {
      const page = lichess ? await lichessPageOfGames() : await chessComPageOfGames();
      games = page.filter((e) => !seen.has(e.gameId));
      for (const e of games) seen.add(e.gameId);
    }
    total += games.length;
    if (!total && done) throw new Error("No public games found for that user.");
    return { games, done };
  }

  return {
    get done() { return done; },
    get loaded() { return total; },
    loadMore() {
      if (done && !inflight) return Promise.resolve({ games: [], done: true });
      if (!inflight) inflight = run().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/* ---------------- shared ---------------- */

function sortByNewest(entries) {
  return entries.slice().sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
}

/** Fetch recent games for a site. `site` is "lichess" or "chesscom". */
export async function fetchRecentGames(username, site, opts = {}) {
  const name = String(username || "").trim();
  if (!name) throw new Error("Type a username first.");
  if (!isValidUsername(name, site)) throw new Error(`That doesn't look like a valid ${site === "lichess" ? "Lichess" : "Chess.com"} username.`);
  const games = site === "lichess"
    ? await fetchLichessRecentGames(name, opts)
    : await fetchChessComRecentGames(name, opts);
  if (!games.length) throw new Error("No public games found for that user.");
  return games;
}

/** Compact one-line label used by the popup list. */
export function describeEntry(entry, viewer) {
  const who = `${entry.white}${entry.whiteElo ? ` (${entry.whiteElo})` : ""} vs ${entry.black}${entry.blackElo ? ` (${entry.blackElo})` : ""}`;
  // Chess.com entries carry "½-½" (see chessComResult) but Lichess entries keep the PGN's own
  // "1/2-1/2" — accept both so a Lichess draw is a Draw, not an unlabeled row.
  const result = entry.result === "1/2-1/2" ? "½-½" : entry.result;
  const mine = viewer && new RegExp(`^${escapeRegExp(viewer)}$`, "i").test(entry.white)
    ? (result === "1-0" ? "Win" : result === "0-1" ? "Loss" : result === "½-½" ? "Draw" : "")
    : viewer && new RegExp(`^${escapeRegExp(viewer)}$`, "i").test(entry.black)
      ? (result === "0-1" ? "Win" : result === "1-0" ? "Loss" : result === "½-½" ? "Draw" : "")
      : "";
  return { who, mine };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
