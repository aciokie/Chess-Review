// puzzle-ui.js — Shared Production Puzzle Practice UI Component for U2
import { PuzzleSolver, PUZZLE_THEMES, DIFFICULTY_BANDS } from "./puzzles.js";

export function renderPuzzleUI(container, puzzle, manager, options = {}) {
  if (!container || !puzzle || !manager) return null;

  const doc = options.document || container.ownerDocument || document;
  const el = (tag, props = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) n.setAttribute(k, "");
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : doc.createTextNode(String(kid)));
    }
    return n;
  };

  let solver = new PuzzleSolver(puzzle);
  let currentTheme = options.currentTheme || "all";
  let currentDiff = options.currentDiff || "all";
  let reviewMissed = options.reviewMissed || false;
  let selectedSq = null;
  let hintSquares = null;
  let pendingPromotion = null;

  const themeSelect = el("select", {
    class: "puzzle-select",
    onchange: (e) => {
      currentTheme = e.target.value;
      if (options.onFilterChange) options.onFilterChange(currentTheme, currentDiff);
    }
  },
    el("option", { value: "all", selected: currentTheme === "all" }, "All Themes"),
    ...PUZZLE_THEMES.map(t => el("option", { value: t, selected: currentTheme === t }, t))
  );

  const diffSelect = el("select", {
    class: "puzzle-select",
    onchange: (e) => {
      currentDiff = e.target.value;
      if (options.onFilterChange) options.onFilterChange(currentTheme, currentDiff);
    }
  },
    el("option", { value: "all", selected: currentDiff === "all" }, "All Difficulties"),
    ...DIFFICULTY_BANDS.map(d => el("option", { value: d, selected: currentDiff === d }, d))
  );

  const feedback = el("div", { class: "puzzle-feedback" });
  const moveInput = el("input", { type: "text", class: "learn-input", placeholder: "Or enter move (e.g. f3g5)" });
  const filterRow = reviewMissed ? null : el("div", { class: "puzzle-filter-row" }, themeSelect, diffSelect);
  const boardWrap = el("div", { class: "puzzle-board-wrap" });

  const renderBoard = () => {
    const chess = solver.chess;
    const fen = chess.fen();
    const sideToMove = chess.turn();
    const files = ["a","b","c","d","e","f","g","h"];
    const ranks = [8,7,6,5,4,3,2,1];
    const flipped = sideToMove === "b";
    const rowOrder = flipped ? [...ranks].reverse() : ranks;
    const colOrder = flipped ? [...files].reverse() : files;

    const boardEl = el("div", { class: "puzzle-board" });
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

    rowOrder.forEach((rank) => {
      colOrder.forEach((file) => {
        const sqName = file + rank;
        const isSel = selectedSq === sqName;
        const isLegal = legalTargets.includes(sqName);
        const isHint = hintSquares && (hintSquares.from === sqName || hintSquares.to === sqName);

        const sqEl = el("div", {
          class: "puzzle-square" + (isSel ? " sel" : "") + (isLegal ? " legal" : "") + (isHint ? " marked" : ""),
          "data-square": sqName,
          onclick: () => handleSqClick(sqName)
        });

        const ch = occ[sqName];
        if (ch) {
          const pieceEl = el("span", {
            class: "piece-img",
            "data-piece": ch
          });
          sqEl.append(pieceEl);
        }
        boardEl.append(sqEl);
      });
    });

    if (pendingPromotion) {
      const promoOverlay = el("div", { class: "puzzle-promo-overlay" },
        ["q", "r", "b", "n"].map((piece) =>
          el("button", {
            class: "puzzle-promo-btn",
            "data-piece": piece,
            onclick: (e) => {
              e.stopPropagation();
              const { from, to } = pendingPromotion;
              pendingPromotion = null;
              executeMove(from, to, piece);
            }
          }, piece.toUpperCase())
        )
      );
      boardWrap.replaceChildren(boardEl, promoOverlay);
    } else {
      boardWrap.replaceChildren(boardEl);
    }
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
    hintSquares = null;
    const res = solver.playMove(from, to, promo);
    if (res.success) {
      if (res.completed) {
        feedback.textContent = "✓ Puzzle Solved!";
        feedback.className = "puzzle-feedback good";
        if (reviewMissed) manager.removeMissed(puzzle.id);
      } else {
        feedback.textContent = `✓ Correct! Opponent played ${res.opponentMove}. Continue...`;
        feedback.className = "puzzle-feedback good";
      }
      moveInput.value = "";
    } else {
      manager.recordMissed(puzzle);
      if (res.reason === "illegal_move") {
        feedback.textContent = "✕ Illegal move on board!";
      } else {
        feedback.textContent = "✕ Incorrect move. Try again, use a hint, or reveal solution.";
      }
      feedback.className = "puzzle-feedback bad";
    }
    renderBoard();
  };

  renderBoard();

  container.replaceChildren(
    filterRow,
    el("div", { class: "puzzle-info-row" },
      el("span", { class: "puzzle-meta" }, `Puzzle #${puzzle.id} · Rating: ${puzzle.rating} · Theme: ${puzzle.theme} (${puzzle.difficulty})`),
      el("span", { class: "puzzle-status" }, `Missed queue: ${manager.getMissed().length}`)
    ),
    el("p", { class: "puzzle-instruction" }, "Find the winning move sequence:"),
    boardWrap,
    el("div", { class: "puzzle-controls-row" },
      moveInput,
      el("button", {
        class: "learn-action-btn submit-btn",
        onclick: () => {
          const val = moveInput.value.trim().toLowerCase();
          if (!val || val.length < 4) return;
          executeMove(val.slice(0, 2), val.slice(2, 4), val.slice(4, 5) || undefined);
        }
      }, "Submit Move"),
      el("button", {
        class: "learn-action-btn sec hint-btn",
        onclick: () => {
          const h = solver.getHint();
          if (h) {
            hintSquares = { from: h.from, to: h.to };
            feedback.textContent = `Hint: Theme is ${h.theme}. Move piece on ${h.from} to ${h.to}.`;
            feedback.className = "puzzle-feedback hint";
            renderBoard();
          }
        }
      }, "Hint"),
      el("button", {
        class: "learn-action-btn sec reveal-btn",
        onclick: () => {
          manager.recordMissed(puzzle);
          const moves = solver.reveal();
          feedback.textContent = `Solution: ${moves.join(" ")}`;
          feedback.className = "puzzle-feedback hint";
          renderBoard();
        }
      }, "Reveal Solution"),
      el("button", {
        class: "learn-action-btn sec retry-btn",
        onclick: () => {
          solver.reset();
          selectedSq = null;
          hintSquares = null;
          pendingPromotion = null;
          moveInput.value = "";
          feedback.textContent = "Puzzle reset to start position.";
          feedback.className = "puzzle-feedback hint";
          renderBoard();
        }
      }, "Retry"),
      el("button", {
        class: "learn-action-btn next-btn",
        onclick: () => {
          if (options.onNextPuzzle) options.onNextPuzzle();
        }
      }, "Next Puzzle →")
    ),
    feedback
  );

  return { solver, renderBoard, executeMove };
}
