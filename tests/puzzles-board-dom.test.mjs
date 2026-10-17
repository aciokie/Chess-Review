import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { Chess } from "../lib/chess.js";
import { PuzzleManager } from "../puzzles.js";
import { renderPuzzleUI } from "../puzzle-ui.js";

test("Puzzle UI DOM interaction - board rendering and piece clicking", async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="puzzleBody"></div></body></html>`, {
    url: "http://localhost"
  });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    writable: true,
    configurable: true
  });

  const manager = new PuzzleManager();
  const rawData = JSON.parse(fs.readFileSync("./data/puzzles.json", "utf8"));
  manager.puzzles = rawData.puzzles;

  const puzzle = manager.getRandomPuzzle("all", "all");
  assert.ok(puzzle, "Puzzle should be loaded");

  const body = document.getElementById("puzzleBody");

  renderPuzzleUI(body, puzzle, manager, {
    currentTheme: "all",
    currentDiff: "all",
    reviewMissed: false,
    onFilterChange: () => {},
    onNextPuzzle: () => {}
  });

  // Verify board elements
  const boardEl = body.querySelector(".puzzle-board");
  assert.ok(boardEl, "Board element should exist");
  const squares = boardEl.querySelectorAll(".puzzle-square");
  assert.equal(squares.length, 64, "Board should contain 64 squares");

  // Test Hint Button
  const hintBtn = Array.from(body.querySelectorAll("button")).find(b => b.textContent.includes("Hint"));
  assert.ok(hintBtn, "Hint button should exist");
  hintBtn.click();

  const statusEl = body.querySelector(".puzzle-feedback") || body.querySelector(".puzzle-status");
  assert.ok(statusEl.textContent.length > 0, "Status should display hint text");

  // Test Move Execution via DOM click
  const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(" ");

  const playerMove = moves[0];
  const fromSq = playerMove.slice(0, 2);
  const toSq = playerMove.slice(2, 4);

  let fromSquareEl = body.querySelector(`.puzzle-square[data-square="${fromSq}"]`);
  let toSquareEl = body.querySelector(`.puzzle-square[data-square="${toSq}"]`);

  assert.ok(fromSquareEl, `From square ${fromSq} should exist`);
  assert.ok(toSquareEl, `To square ${toSq} should exist`);

  // Click source square
  fromSquareEl.click();

  // Re-query square after re-render
  fromSquareEl = body.querySelector(`.puzzle-square[data-square="${fromSq}"]`);
  assert.ok(fromSquareEl.classList.contains("sel") || fromSquareEl.classList.contains("selected"), "From square should be selected");

  // Click target square
  toSquareEl = body.querySelector(`.puzzle-square[data-square="${toSq}"]`);
  toSquareEl.click();

  // Feedback should update
  const feedbackEl = body.querySelector(".puzzle-feedback");
  assert.ok(feedbackEl.textContent.length > 0, "Feedback should update after move");

  // Test Reveal button
  const revealBtn = Array.from(body.querySelectorAll("button")).find(b => b.textContent.includes("Reveal"));
  if (revealBtn) {
    revealBtn.click();
    assert.ok(body.querySelector(".puzzle-feedback").textContent.includes("Solution"), "Reveal should update feedback");
  }
});
