// lichess.js — helpers for fetching a game's PGN from Lichess's public API.
// Imported as an ES module by analyze-flow.js and popup.js.
//
// Public API (no key/login required):
//   Export one game:  GET https://lichess.org/game/export/{gameId}
//     Accept: application/x-chess-pgn  → returns the full PGN (tags + moves).
//
// Lichess game IDs are 8 characters. A URL may carry a 12-char id (the 8-char id plus a
// 4-char player token, e.g. while/just after playing) and/or a trailing /white | /black |
// /analysis segment — we always reduce to the canonical 8-char base id.

import { getCachedGame, setCachedGame } from "./gamecache.js";

const SITE = "https://lichess.org";

// 8-char first-path segments that are Lichess routes, not games (so /training, /analysis,
// /practice, /streamer … are never mistaken for a game id).
const RESERVED = /^(training|analysis|practice|streamer|tournament|broadcast)$/i;

/** Parse the 8-char Lichess game id from a URL or path. Returns { id } or null. */
export function parseLichessGameId(urlOrPath) {
  if (!urlOrPath) return null;
  let path;
  try {
    path = new URL(urlOrPath, SITE).pathname;
  } catch {
    path = String(urlOrPath);
  }
  const seg = path.replace(/^\/+/, "").split(/[/?#]/)[0] || "";
  // Game ids are 8 chars; URLs sometimes append the 4-char player token (12 total).
  if (!/^[A-Za-z0-9]{8,12}$/.test(seg)) return null;
  if (RESERVED.test(seg)) return null;
  return { id: seg.slice(0, 8) };
}

/**
 * Read the board perspective from a Lichess URL. A game URL may carry a trailing colour segment
 * (/<id>/black or /<id>/white) naming the side shown at the bottom. Tri-state: true (Black at
 * bottom) / false (White) / null (no hint — defer to the board orientation or username match).
 */
export function parseLichessFlip(urlOrPath) {
  if (!urlOrPath) return null;
  let path;
  try { path = new URL(urlOrPath, SITE).pathname; } catch { path = String(urlOrPath); }
  if (/\/black(?:\/|$)/i.test(path)) return true;
  if (/\/white(?:\/|$)/i.test(path)) return false;
  return null;
}

/**
 * Fetch the PGN for a Lichess game by id. Clocks/evals/literate annotations are turned off so
 * the movetext stays clean for the analyzer. Returns the PGN string (throws on failure).
 */
export async function fetchGamePgn(gameId) {
  const id = String(gameId || "").slice(0, 8);
  if (!/^[A-Za-z0-9]{8}$/.test(id)) throw new Error("Invalid Lichess game id.");
  // Cache first: a finished game's PGN is immutable, so a re-analysis costs no API call.
  const cached = await getCachedGame("lichess", id);
  if (typeof cached === "string" && cached.trim()) return cached;
  const url = `${SITE}/game/export/${encodeURIComponent(id)}?clocks=false&evals=false&literate=false`;
  const res = await fetch(url, { headers: { Accept: "application/x-chess-pgn" } });
  if (!res.ok) throw new Error(`Lichess returned HTTP ${res.status} for game ${id}.`);
  const pgn = (await res.text()).trim();
  if (!pgn) throw new Error("Lichess returned an empty PGN.");
  // Only cache a finished game — an in-progress game exports a partial PGN with [Result "*"], which we
  // must not freeze (the next analysis should re-fetch the completed game).
  if (!/\[Result\s+"\*"\]/.test(pgn)) setCachedGame("lichess", id, pgn);
  return pgn;
}

/** Helper to parse PGN header tags into a key-value object */
export function parsePgnHeaders(pgnText) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(pgnText))) {
    headers[m[1]] = m[2];
  }
  return headers;
}

/**
 * Fetch user games list from Lichess with pagination and time class filtering.
 * Returns { games, until, hasMore }
 */
export async function fetchLichessUserGamesList(username, { limit = 50, until = null, timeClass = "all" } = {}) {
  const normUser = username.toLowerCase();
  let perfType = "";
  const tcLower = (timeClass || "all").toLowerCase();
  if (tcLower === "bullet") perfType = "bullet";
  else if (tcLower === "blitz") perfType = "blitz";
  else if (tcLower === "rapid") perfType = "rapid";
  else if (tcLower === "daily") perfType = "correspondence";

  let url = `${SITE}/api/games/user/${encodeURIComponent(username)}?max=${limit}&opening=true&clocks=false&evals=false`;
  if (until) url += `&until=${until}`;
  if (perfType) url += `&perfType=${perfType}`;

  const res = await fetch(url, { headers: { Accept: "application/x-chess-pgn" } });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Lichess user '${username}' not found.`);
    }
    throw new Error(`Lichess returned HTTP ${res.status}`);
  }

  const rawPgnText = await res.text();
  if (!rawPgnText || !rawPgnText.trim()) {
    return { games: [], until: null, hasMore: false };
  }

  // Split multi-game PGN string into individual PGNs
  const blocks = rawPgnText.split(/\n\n(?=\[Event )|\n(?=\[Event )/).filter((b) => b.trim().length > 0);
  const games = [];
  let oldestTimestamp = null;

  for (const block of blocks) {
    const pgn = block.trim();
    if (!pgn) continue;

    const headers = parsePgnHeaders(pgn);
    const siteUrl = headers.Site || "";
    const parsed = parseLichessGameId(siteUrl);
    const gameId = parsed?.id || Math.random().toString(36).slice(2, 10);

    const whiteUser = headers.White || "White";
    const blackUser = headers.Black || "Black";
    const isWhite = whiteUser.toLowerCase() === normUser;

    const resHeader = headers.Result || "*";
    let outcome = "loss";
    if (resHeader === "1-0") outcome = isWhite ? "win" : "loss";
    else if (resHeader === "0-1") outcome = !isWhite ? "win" : "loss";
    else if (resHeader.includes("1/2")) outcome = "draw";

    // Deduce time class
    const eventName = (headers.Event || "").toLowerCase();
    let gTimeClass = "blitz";
    if (eventName.includes("bullet")) gTimeClass = "bullet";
    else if (eventName.includes("rapid")) gTimeClass = "rapid";
    else if (eventName.includes("classical")) gTimeClass = "classical";
    else if (eventName.includes("correspondence") || eventName.includes("daily")) gTimeClass = "daily";

    // Timestamp
    let endTime = Date.now();
    if (headers.UTCDate) {
      const dateStr = headers.UTCDate.replace(/\./g, "-");
      const timeStr = headers.UTCTime || "00:00:00";
      const parsedTime = Date.parse(`${dateStr}T${timeStr}Z`);
      if (!isNaN(parsedTime)) {
        endTime = parsedTime;
      }
    }
    oldestTimestamp = endTime;

    games.push({
      id: gameId,
      platform: "lichess",
      url: siteUrl || `${SITE}/${gameId}`,
      pgn,
      timeClass: gTimeClass,
      timeControl: headers.TimeControl || gTimeClass,
      endTime,
      white: {
        username: whiteUser,
        rating: headers.WhiteElo ? parseInt(headers.WhiteElo, 10) : null,
        result: resHeader === "1-0" ? "win" : resHeader === "0-1" ? "loss" : "draw"
      },
      black: {
        username: blackUser,
        rating: headers.BlackElo ? parseInt(headers.BlackElo, 10) : null,
        result: resHeader === "0-1" ? "win" : resHeader === "1-0" ? "loss" : "draw"
      },
      mySide: isWhite ? "w" : "b",
      opponent: {
        username: isWhite ? blackUser : whiteUser,
        rating: isWhite ? (headers.BlackElo ? parseInt(headers.BlackElo, 10) : null) : (headers.WhiteElo ? parseInt(headers.WhiteElo, 10) : null)
      },
      result: outcome
    });
  }

  const hasMore = games.length === limit;
  // If we have games, set until = oldestTimestamp - 1ms
  const nextUntil = oldestTimestamp ? oldestTimestamp - 1 : null;

  return {
    games,
    until: nextUntil,
    hasMore
  };
}
