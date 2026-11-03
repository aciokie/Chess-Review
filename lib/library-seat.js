// lib/library-seat.js — which seat of a saved game an account holds, and how to reopen the game
// facing them.
//
// This is one rule shared by every door into a saved game: the Progress page (which reports on a
// single account) and the analyzer's own library sidebar. A library can also hold games saved from
// the opponent's seat — a friend's copy, or a record saved before the handle was known — and the two
// doors used to disagree about the board orientation, so the same game opened facing different
// players and a "move N" link landed on the opponent's view of their own move.
//
// Pure: it reads only the record. No storage, no DOM (see tests/progress.test.mjs).

/** Lower-cased, trimmed comparison form of a player name. */
export const normName = (value) => String(value == null ? "" : value).trim().toLowerCase();

/**
 * Which side of a record the given account played ("w" | "b"), or null when they are neither player.
 * Matches either seat, because a library can also hold games saved from the opponent's perspective.
 */
export function playerSide(record, username) {
  const who = normName(username);
  if (!who || !record) return null;
  const saved = record.meSide === "b" ? "b" : "w";
  if (normName(record.myName) === who) return saved;
  if (normName(record.opName) === who) return saved === "b" ? "w" : "b";
  return null;
}

/**
 * The board orientation to reopen a saved game with, from one account's point of view. `meta.flip`
 * records the orientation the review was SAVED with, so it only describes that account when the game
 * was saved for them; a record saved from the other seat has to open facing the account in question,
 * or a deep link to "your move" lands on the opponent's board. With no handle (or when the account is
 * not in the game) the saved orientation is reproduced exactly as it was.
 */
export function libraryFlip(record, username) {
  const saved = record?.meSide === "b" ? "b" : "w";
  const side = playerSide(record, username);
  if (side && side !== saved) return side === "b";
  const hint = record?.meta?.flip;
  return hint != null ? !!hint : saved === "b";
}
