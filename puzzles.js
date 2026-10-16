// puzzles.js — Offline Lichess Puzzle Manager for U2
import { browserAPI } from "./browser-compat.js";

export const PUZZLE_THEMES = [
  "fork", "pin", "skewer", "discoveredAttack", "doubleCheck", "sacrifice",
  "deflection", "decoy", "intermezzo", "zugzwang", "backRankMate", "endgame"
];

export const DIFFICULTY_BANDS = ["easy", "medium", "hard"];

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
      this.puzzles = data.puzzles || [];
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
