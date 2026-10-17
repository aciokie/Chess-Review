import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { PuzzleSolver } from "../puzzles.js";

// Helper function to build DOM puzzle view and test actual square clicks
function createDOMPuzzleView(puzzle) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="puzzleBody"></div></body></html>`);
  const document = dom.window.document;
  const solver = new PuzzleSolver(puzzle);

  let selectedSq = null;
  let pendingPromotion = null;
  let feedbackText = "";

  const renderBoard = () => {
    const body = document.getElementById("puzzleBody");
    const chess = solver.chess;
    const fen = chess.fen();
    const sideToMove = chess.turn();
    const files = ["a","b","c","d","e","f","g","h"];
    const ranks = [8,7,6,5,4,3,2,1];

    const boardWrap = document.createElement("div");
    boardWrap.className = "puzzle-board-wrap";

    const boardEl = document.createElement("div");
    boardEl.className = "board puzzle-board";

    const rows = fen.split(" ")[0].split("/");
    const occ = {};
    for (let r = 0; r < 8; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) c += +ch;
        else { occ["abcdefgh"[c] + (8 - r)] = ch; c++; }
      }
    }

    let legalTargets = [];
    if (selectedSq) {
      try {
        legalTargets = chess.moves({ square: selectedSq, verbose: true }).map(m => m.to);
      } catch { legalTargets = []; }
    }

    ranks.forEach((rank) => {
      files.forEach((file) => {
        const sqName = file + rank;
        const isSel = selectedSq === sqName;
        const isLegal = legalTargets.includes(sqName);

        const sqEl = document.createElement("div");
        sqEl.className = "sq " + (isSel ? " sel" : "") + (isLegal ? " legal" : "");
        sqEl.setAttribute("data-sq", sqName);
        sqEl.onclick = () => handleSqClick(sqName);

        const ch = occ[sqName];
        if (ch) {
          const pEl = document.createElement("span");
          pEl.className = "piece-img";
          pEl.setAttribute("data-piece", ch);
          sqEl.appendChild(pEl);
        }
        boardEl.appendChild(sqEl);
      });
    });

    if (pendingPromotion) {
      const promoOverlay = document.createElement("div");
      promoOverlay.className = "puzzle-promo-overlay";
      ["q", "r", "b", "n"].forEach((piece) => {
        const btn = document.createElement("button");
        btn.className = "puzzle-promo-btn";
        btn.setAttribute("data-piece", piece);
        btn.textContent = piece.toUpperCase();
        btn.onclick = (e) => {
          const { from, to } = pendingPromotion;
          pendingPromotion = null;
          executeMove(from, to, piece);
        };
        promoOverlay.appendChild(btn);
      });
      boardWrap.appendChild(boardEl);
      boardWrap.appendChild(promoOverlay);
    } else {
      boardWrap.appendChild(boardEl);
    }

    const feedbackEl = document.createElement("div");
    feedbackEl.className = "puzzle-feedback";
    feedbackEl.textContent = feedbackText;

    body.replaceChildren(boardWrap, feedbackEl);
  };

  const handleSqClick = (sqName) => {
    if (solver.completed || pendingPromotion) return;
    const chess = solver.chess;
    const piece = chess.get(sqName);
    const sideToMove = chess.turn();

    if (selectedSq) {
      if (selectedSq === sqName) {
        selectedSq = null;
        renderBoard();
        return;
      }

      if (piece && piece.color === sideToMove) {
        selectedSq = sqName;
        renderBoard();
        return;
      }

      const from = selectedSq;
      const to = sqName;
      const movingPiece = chess.get(from);
      const isLegal = chess.moves({ square: from, verbose: true }).some(m => m.to === to);

      if (movingPiece && movingPiece.type === "p" && (to.endsWith("8") || to.endsWith("1")) && isLegal) {
        pendingPromotion = { from, to };
        selectedSq = null;
        renderBoard();
        return;
      }

      selectedSq = null;
      executeMove(from, to);
      return;
    }

    if (piece && piece.color === sideToMove) {
      selectedSq = sqName;
    } else {
      selectedSq = null;
    }
    renderBoard();
  };

  const executeMove = (from, to, promo) => {
    const res = solver.playMove(from, to, promo);
    if (res.success) {
      feedbackText = res.completed ? "✓ Puzzle Solved!" : `✓ Correct! Opponent played ${res.opponentMove}. Continue...`;
    } else {
      feedbackText = "✕ Incorrect move.";
    }
    renderBoard();
  };

  renderBoard();
  return { document, solver };
}

test("DOM Puzzle View renders exactly 64 squares and correct initial piece elements", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const { document } = createDOMPuzzleView(puzzle);
  const squares = document.querySelectorAll(".sq");
  assert.equal(squares.length, 64, "renders 64 squares");

  const f3Square = document.querySelector('.sq[data-sq="f3"]');
  assert.ok(f3Square.querySelector('.piece-img[data-piece="N"]'), "f3 contains white knight");
});

test("DOM Puzzle View handles DOM clicks for selection, re-selection, move submission and opponent replies", () => {
  const puzzle = {
    id: "p0001",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    moves: ["f3g5", "d7d5", "e4d5"],
    theme: "fork",
    difficulty: "easy"
  };

  const { document, solver } = createDOMPuzzleView(puzzle);

  // Click f2 (pawn) then re-select f3 (knight)
  document.querySelector('.sq[data-sq="f2"]').onclick();
  assert.ok(document.querySelector('.sq[data-sq="f2"]').classList.contains("sel"));

  document.querySelector('.sq[data-sq="f3"]').onclick();
  assert.ok(document.querySelector('.sq[data-sq="f3"]').classList.contains("sel"));

  // Click g5 destination -> executes f3g5 and triggers opponent reply d7d5
  document.querySelector('.sq[data-sq="g5"]').onclick();
  assert.equal(solver.moveIdx, 2);
  const feedback = document.querySelector(".puzzle-feedback").textContent;
  assert.ok(feedback.includes("Opponent played d7d5"), "feedback mentions opponent move");

  // Click e4 then d5 to solve puzzle
  document.querySelector('.sq[data-sq="e4"]').onclick();
  document.querySelector('.sq[data-sq="d5"]').onclick();
  assert.equal(solver.completed, true);
  assert.ok(document.querySelector(".puzzle-feedback").textContent.includes("Solved"));
});

test("DOM Puzzle View renders promotion overlay and handles underpromotions via DOM button clicks", () => {
  const underPromoPuzzle = {
    id: "p_underpromo",
    fen: "8/4P3/8/8/8/8/8/4K2k w - - 0 1",
    moves: ["e7e8n"],
    theme: "fork",
    difficulty: "medium"
  };

  const { document, solver } = createDOMPuzzleView(underPromoPuzzle);

  // Click e7 pawn then e8 square -> triggers promotion overlay
  document.querySelector('.sq[data-sq="e7"]').onclick();
  document.querySelector('.sq[data-sq="e8"]').onclick();

  const overlay = document.querySelector(".puzzle-promo-overlay");
  assert.ok(overlay, "promotion overlay appears");

  // Click 'N' button for knight underpromotion
  const knightBtn = overlay.querySelector('button[data-piece="n"]');
  assert.ok(knightBtn, "knight promotion button exists");
  knightBtn.onclick();

  assert.equal(solver.completed, true, "puzzle completed with knight underpromotion");
  assert.equal(solver.chess.get("e8")?.type, "n");
});
