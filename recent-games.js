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

/** Lichess time control string → coarse class (mirrors Lichess's own breakpoints). */
export function timeClassFromLichessTimeControl(tc) {
  const raw = String(tc || "").trim();
  if (!raw || raw === "-") return "unlimited";
  const base = Number.parseInt(raw.split("+")[0], 10);
  if (!Number.isFinite(base)) return "unknown";
  if (base < 180) return "bullet";
  if (base < 480) return "blitz";
  if (base < 1500) return "rapid";
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

/**
 * The latest games of a Lichess user, newest first. Uses the bulk PGN export (one request for all
 * N games) with clocks/evals off so the movetext stays clean for the analyzer.
 */
export async function fetchLichessRecentGames(username, { max = RECENT_MAX, fetchImpl = fetch } = {}) {
  const url = `${LICHESS_SITE}/api/games/user/${encodeURIComponent(username.trim())}?max=${max}&clocks=false&evals=false&literate=false&opening=true&perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence`; // perfType = standard chess only (variants have their own perf types)
  const res = await fetchImpl(url, { headers: { Accept: "application/x-chess-pgn" } });
  if (res.status === 404) throw new Error("Lichess user not found (or no public games).");
  if (res.status === 429) throw new Error("Lichess rate-limited the request — try again in a minute.");
  if (!res.ok) throw new Error(`Lichess returned HTTP ${res.status}.`);
  const text = await res.text();
  const entries = splitMultiGamePgn(text).map(lichessGameToEntry).filter(Boolean);
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
    opening: "",
    eco: "",
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
  const mine = viewer && new RegExp(`^${escapeRegExp(viewer)}$`, "i").test(entry.white)
    ? (entry.result === "1-0" ? "Win" : entry.result === "0-1" ? "Loss" : entry.result === "½-½" ? "Draw" : "")
    : viewer && new RegExp(`^${escapeRegExp(viewer)}$`, "i").test(entry.black)
      ? (entry.result === "0-1" ? "Win" : entry.result === "1-0" ? "Loss" : entry.result === "½-½" ? "Draw" : "")
      : "";
  return { who, mine };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
