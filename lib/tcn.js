// lib/tcn.js — decode Chess.com's TCN (two-character-per-ply) moveList into UCI moves,
// and rebuild a PGN via lib/chess.js.
//
// Chess.com's /callback/live/game/{id} returns moveList as a string of 2-char tokens
// drawn from an 84-char alphabet, one token per ply — no PGN field is provided. This
// module is pure: no DOM, no network, no engine — Node-testable.

import { Chess } from "./chess.js";

// TCN alphabet — 84 chars, index encodes square+piece. Matches the chess-tcn-js reference.
export const TCN_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=";

const INDEX = new Map();
for (let i = 0; i < TCN_ALPHABET.length; i++) INDEX.set(TCN_ALPHABET[i], i);

// Square index 0..63: index%8 = file (a-h), Math.floor(index/8) = rank (1-8).
function squareFromIndex(n) {
  return String.fromCharCode(97 + (n % 8)) + (Math.floor(n / 8) + 1);
}

// Promotion destinations are encoded above index 63. (to - 64) / 3 → piece; remainder → dest.
const PROMO_PIECES = "qnrbkp";

/** Decode a TCN moveList string into an array of {from, to, promotion?} UCI moves. */
export function decodeTcn(tcn) {
  if (typeof tcn !== "string") throw new Error("TCN must be a string");
  const moves = [];
  for (let i = 0; i + 1 < tcn.length; i += 2) {
    const from = INDEX.get(tcn[i]);
    const to = INDEX.get(tcn[i + 1]);
    if (from == null || to == null) throw new Error("Bad TCN char at " + i);
    // Indices above 75 are drop/variant markers we cannot represent in standard UCI.
    if (from > 75) continue;
    let promotion = "";
    let dest = to;
    if (to > 63) {
      promotion = PROMO_PIECES[Math.floor((to - 64) / 3)] || "";
      dest = from + (from < 16 ? -8 : 8) + ((to - 1) % 3) - 1;
    }
    moves.push({
      from: squareFromIndex(from),
      to: squareFromIndex(dest),
      ...(promotion ? { promotion } : {}),
    });
  }
  return moves;
}

/**
 * Rebuild a PGN from a /callback/live/game/{id} JSON payload: pgnHeaders + TCN moveList.
 * Returns a PGN string (headers + movetext). Throws if the moveList can't be decoded.
 */
export function tcnToPgn(callbackData) {
  const game = callbackData.game || callbackData;
  const headers = { ...(game.pgnHeaders || {}) };
  const chess = new Chess();
  // Live games always start from the standard position; drop any SetUp/FEN tags.
  delete headers.SetUp;
  delete headers.FEN;
  for (const [k, v] of Object.entries(headers)) {
    if (v != null && v !== "") chess.setHeader(k, String(v));
  }
  for (const m of decodeTcn(game.moveList || "")) {
    chess.move(m);
  }
  return chess.pgn();
}
