// lib/page-moves.js — turn the SAN move list a game page shows into a PGN.
//
// Chess.com publishes no data for guest games: the public archive has no entry for a "Guest…"
// account, and /callback/live/game/{id} answers 404 {"message":"Game is not found."} for them
// (verified on a real guest game). The page itself always renders the game — the move list and
// the result — so that is the only source left. This module converts those scraped tokens into a
// PGN. Pure: no DOM, no network, no engine — Node-testable.

import { Chess } from "./chess.js";

// Result strings a move list can carry as if they were moves.
const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "½-½", "0.5-0.5", "*"]);

// Move numbers ("12.", "12...") and clock labels ("0.1s") sit in the same list.
const MOVE_NUMBER_RE = /^\d+\.*$/;

// A permissive SAN shape: castling, or piece/pawn + optional disambiguation/capture + destination
// + optional promotion, with optional check/mate marks. Deliberately loose — lib/chess.js is the
// authority on legality, and it rejects anything this lets through.
const SAN_RE = /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/;

/** Strip annotation glyphs and spacing from one scraped token ("Nf3!" → "Nf3"). */
export function cleanSanToken(token) {
  return String(token ?? "").replace(/[\u00a0\s]+/g, "").replace(/[!?]+$/g, "");
}

/**
 * Build a PGN from SAN moves scraped off a game page.
 *
 * @param {string[]|string} moves  SAN tokens (an array, or one whitespace-separated string)
 * @param {object} headers         PGN headers, e.g. { White, Black, Result }
 * @returns {string} headers + movetext
 * @throws if the list is empty or holds no playable moves
 */
export function sanMovesToPgn(moves, headers = {}) {
  const list = Array.isArray(moves) ? moves : String(moves || "").split(/\s+/);
  const chess = new Chess();
  for (const [key, value] of Object.entries(headers)) {
    if (value != null && value !== "") chess.setHeader(key, String(value));
  }
  let plies = 0;
  let skipped = 0;
  for (const raw of list) {
    const san = cleanSanToken(raw);
    if (!san || RESULT_TOKENS.has(san) || MOVE_NUMBER_RE.test(san) || !SAN_RE.test(san)) continue;
    try {
      chess.move(san);
    } catch {
      // A variation spliced into the main line, a half-read token, or a different game entirely:
      // skip it rather than failing the whole import — the page's move list is the only source.
      skipped++;
      continue;
    }
    plies++;
  }
  if (!plies) throw new Error("The page's move list is empty");
  return chess.pgn();
}
