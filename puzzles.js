// puzzles.js — Offline Lichess Puzzle Manager & Validator for U2
import { browserAPI } from "./browser-compat.js";
import { Chess } from "./lib/chess.js";

export const PUZZLE_THEMES = [
  "fork", "pin", "skewer", "discoveredAttack", "doubleCheck", "sacrifice",
  "deflection", "decoy", "intermezzo", "zugzwang", "backRankMate", "endgame"
];

export const DIFFICULTY_BANDS = ["easy", "medium", "hard"];

export function validatePuzzleRecord(p) {
  if (!p || typeof p !== "object") return "Malformed record: not an object";
  if (!p.id || typeof p.id !== "string") return "Missing or invalid id";
  if (!p.fen || typeof p.fen !== "string") return "Missing or invalid FEN";
  if (!Array.isArray(p.moves) || p.moves.length === 0) return "Missing or empty moves array";
  if (!p.theme || !PUZZLE_THEMES.includes(p.theme)) return `Unsupported theme: ${p.theme}`;
  if (!p.difficulty || !DIFFICULTY_BANDS.includes(p.difficulty)) return `Unsupported difficulty: ${p.difficulty}`;

  let chess;
  try {
    chess = new Chess(p.fen);
  } catch (e) {
    return `Invalid FEN position: ${p.fen}`;
  }

  for (const m of p.moves) {
    if (typeof m !== "string" || m.length < 4) return `Malformed move string: ${m}`;
    let res;
    try {
      res = chess.move({
        from: m.slice(0, 2),
        to: m.slice(2, 4),
        promotion: m.slice(4, 5) || undefined,
      });
    } catch {
      res = null;
    }
    if (!res) return `Illegal move ${m} in position ${p.fen}`;
  }

  return null; // Valid record
}

export function validatePuzzleDataset(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.puzzles)) {
    return { valid: false, error: "Dataset missing puzzles array" };
  }

  const ids = new Set();
  const fens = new Set();
  const contentKeys = new Set();
  const themesSeen = new Set();
  const diffsSeen = new Set();

  for (let i = 0; i < data.puzzles.length; i++) {
    const p = data.puzzles[i];
    const err = validatePuzzleRecord(p);
    if (err) return { valid: false, error: `Puzzle #${i} (${p?.id}): ${err}` };

    if (ids.has(p.id)) return { valid: false, error: `Duplicate puzzle ID: ${p.id}` };
    ids.add(p.id);

    if (fens.has(p.fen)) return { valid: false, error: `Duplicate FEN position: ${p.fen}` };
    fens.add(p.fen);

    const contentKey = `${p.fen}|${p.moves.join(",")}`;
    if (contentKeys.has(contentKey)) return { valid: false, error: `Duplicate puzzle content: ${p.id}` };
    contentKeys.add(contentKey);

    themesSeen.add(p.theme);
    diffsSeen.add(p.difficulty);
  }

  for (const theme of PUZZLE_THEMES) {
    if (!themesSeen.has(theme)) return { valid: false, error: `Missing required theme: ${theme}` };
  }

  for (const diff of DIFFICULTY_BANDS) {
    if (!diffsSeen.has(diff)) return { valid: false, error: `Missing required difficulty: ${diff}` };
  }

  return { valid: true, count: data.puzzles.length };
}

export class PuzzleManager {
  constructor() {
    this.puzzles = [];
    this.missedPuzzles = [];
    this.currentIndex = 0;
  }

  async loadPuzzles() {
    try {
      const res = await fetch(browserAPI.runtime.getURL("data/puzzles.json"));
      const data = await res.json();
      const validation = validatePuzzleDataset(data);
      if (validation.valid) {
        this.puzzles = data.puzzles;
      } else {
        console.error("Puzzle dataset validation failed:", validation.error);
        this.puzzles = [];
      }
    } catch {
      this.puzzles = [];
    }

    try {
      const stored = await browserAPI.storage.local.get("missedPuzzles");
      this.missedPuzzles = stored.missedPuzzles || [];
    } catch {
      this.missedPuzzles = [];
    }
  }

  filterPuzzles(theme = "all", difficulty = "all") {
    return this.puzzles.filter((p) => {
      const matchTheme = theme === "all" || p.theme === theme;
      const matchDiff = difficulty === "all" || p.difficulty === difficulty;
      return matchTheme && matchDiff;
    });
  }

  recordMissed(puzzle) {
    if (!this.missedPuzzles.some((p) => p.id === puzzle.id)) {
      this.missedPuzzles.push(puzzle);
      browserAPI.storage.local.set({ missedPuzzles: this.missedPuzzles });
    }
  }

  getMissed() {
    return this.missedPuzzles;
  }
}
