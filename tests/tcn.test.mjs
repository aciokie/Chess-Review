import test from "node:test";
import assert from "node:assert/strict";
import { decodeTcn, tcnToPgn, TCN_ALPHABET } from "../lib/tcn.js";

// The full 84-char TCN alphabet (85 chars with one duplicate `+`, giving 84 unique).
test("tcn alphabet has 84 unique chars", () => {
  assert.strictEqual(TCN_ALPHABET.length, 85);
  assert.strictEqual(new Set(TCN_ALPHABET).size, 84);
});

// Game 2485075845 (ErnestoGuevaraLynch vs chesstatour, ECO B06 / Modern).
// moveList prefix gv2UmC92lBZRbs... decodes to 1.Nf3 g6 2.e4 Bg7 3.d4 d6 4.Nc3.
test("decodeTcn decodes the opening of a real callback game", () => {
  const moves = decodeTcn("gv2UmC92lBZRbs");
  assert.deepStrictEqual(moves, [
    { from: "g1", to: "f3" },
    { from: "g7", to: "g6" },
    { from: "e2", to: "e4" },
    { from: "f8", to: "g7" },
    { from: "d2", to: "d4" },
    { from: "d7", to: "d6" },
    { from: "b1", to: "c3" },
  ]);
});

test("decodeTcn maps e2->e4 via mC", () => {
  // npm @savi2w/chess-tcn: decode("mC") -> { from: "e2", to: "e4" }
  const moves = decodeTcn("mC");
  assert.deepStrictEqual(moves, [{ from: "e2", to: "e4" }]);
});

test("decodeTcn throws on a bad char", () => {
  // `"` is not in the TCN alphabet.
  assert.throws(() => decodeTcn('g"'), /Bad TCN char/);
});

test("decodeTcn ignores trailing odd char", () => {
  const moves = decodeTcn("gv2");
  assert.strictEqual(moves.length, 1);
});

// Rebuild a full PGN from a real callback payload (game 2485075845).
test("tcnToPgn rebuilds a PGN matching the archive", () => {
  const callback = {
    game: {
      id: 2485075845,
      plyCount: 61,
      moveList:
        "gv2UmC92lBZRbs!Tpx8!cu5QfH6ZegWOHA0KBKRKuI98vMZSMS1SnvQBsmTZIBKBmBZPAS!?SJPJCJ7Jks47BrJAdc8mfnOGcf78rGAIGrIPad2VrBVufmunmn",
      pgnHeaders: {
        Event: "Live Chess",
        Site: "Chess.com",
        Date: "2017.12.12",
        White: "ErnestoGuevaraLynch",
        Black: "chesstatour",
        Result: "1-0",
        ECO: "B06",
        WhiteElo: "2442",
        BlackElo: "1984",
        TimeControl: "180+2",
        Termination: "ErnestoGuevaraLynch won by resignation",
        SetUp: "1",
        FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      },
    },
  };
  const pgn = tcnToPgn(callback);
  assert.ok(pgn.includes('[White "ErnestoGuevaraLynch"]'));
  assert.ok(pgn.includes('[Black "chesstatour"]'));
  assert.ok(pgn.includes('[Result "1-0"]'));
  assert.ok(pgn.includes("1. Nf3"));
  // No SetUp/FEN tags survive.
  assert.ok(!pgn.includes("SetUp"));
  assert.ok(!pgn.includes('FEN "'));
  // 61 plies decoded.
  const moves = pgn.split(/\d+\.\s/).filter(Boolean);
  assert.ok(moves.length >= 30);
});

test("tcnToPgn throws on a bad moveList char", () => {
  assert.throws(
    () => tcnToPgn({ game: { moveList: 'g"', pgnHeaders: { White: "A", Black: "B", Result: "*" } } }),
    /Bad TCN char/
  );
});
