// play-coach.js — Play Coach Mode core logic & state management.
// Operates independently using chess.js, engine UCI, coach phrase banks, and classification rules.

import { Chess } from "./lib/chess.js";

export const COACH_STRENGTHS = {
  beginner: { name: "Beginner", depth: 3, skill: 2, multipv: 3, description: "Casual play with frequent tactical mistakes." },
  casual: { name: "Casual", depth: 5, skill: 6, multipv: 2, description: "Plays decent chess with occasional inaccuracies." },
  intermediate: { name: "Intermediate", depth: 8, skill: 12, multipv: 1, description: "Solid strategic player with fewer blunders." },
  advanced: { name: "Advanced", depth: 12, skill: 18, multipv: 1, description: "Strong tactical and positional play." },
  expert: { name: "Expert", depth: 15, skill: 20, multipv: 1, description: "Full strength engine play." },
};

export const COACH_PERSONALITIES = [
  { id: "mentor", name: "Ralph (Mentor)", title: "Warm & Educational" },
  { id: "wise_grandma", name: "Wise Grandma", title: "Encouraging & Wise" },
  { id: "life_coach", name: "Julie", title: "Positive & Inspiring" },
  { id: "old_soviet", name: "Old Soviet", title: "Strict & Classical" },
  { id: "hustler", name: "Hustler", title: "Sharp & Streetwise" },
  { id: "kid_prodigy", name: "Kid Prodigy", title: "Energetic & Fast" },
  { id: "professor", name: "Professor", title: "Academic & Detailed" },
  { id: "drunk_uncle", name: "Drunk Uncle", title: "Unpredictable & Fun" },
  { id: "conspiracy_theorist", name: "Conspiracy Theorist", title: "Suspicious & Eccentric" },
  { id: "nature_documentarian", name: "Nature Documentarian", title: "Observational & Calm" },
];

export class PlayCoachGame {
  constructor(options = {}) {
    this.userColor = options.userColor === "b" ? "b" : (options.userColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : "w");
    this.strength = options.strength && COACH_STRENGTHS[options.strength] ? options.strength : "intermediate";
    this.coachId = options.coachId || "mentor";
    this.settings = {
      showEval: options.showEval !== undefined ? options.showEval : true,
      showCoachSuggestions: options.showCoachSuggestions !== undefined ? options.showCoachSuggestions : true,
      showThreats: options.showThreats !== undefined ? options.showThreats : true,
      enableFeedback: options.enableFeedback !== undefined ? options.enableFeedback : true,
      enableHints: options.enableHints !== undefined ? options.enableHints : true,
      allowTakebacks: options.allowTakebacks !== undefined ? options.allowTakebacks : true,
      feedbackFrequency: options.feedbackFrequency || "all",
      ...options.settings,
    };

    this.chess = new Chess();
    this.history = []; // Array of { fen, san, uci, move, color, eval, classification, feedback }
    this.undoStack = []; // History snapshots for takebacks
    this.status = "playing"; // "playing", "ended"
    this.gameResult = null; // { winner, reason, text }
    this.currentHintLevel = 0;
    this.lastThreat = null;
    this.lastFeedback = null;
    this.requestId = 0;

    // Save initial state
    this._saveSnapshot();
  }

  _saveSnapshot() {
    this.undoStack.push({
      fen: this.chess.fen(),
      history: JSON.parse(JSON.stringify(this.history)),
      status: this.status,
      gameResult: this.gameResult ? { ...this.gameResult } : null,
      lastThreat: this.lastThreat,
      lastFeedback: this.lastFeedback,
    });
  }

  get fen() {
    return this.chess.fen();
  }

  get turn() {
    return this.chess.turn();
  }

  get isUserTurn() {
    return this.status === "playing" && this.turn === this.userColor;
  }

  get pgn() {
    return this.chess.pgn();
  }

  /**
   * User plays a move (LAN or object like { from: 'e2', to: 'e4', promotion: 'q' } or SAN).
   */
  makeUserMove(moveInput) {
    if (this.status !== "playing") throw new Error("Game is over.");
    if (!this.isUserTurn) throw new Error("Not your turn.");

    const res = this.chess.move(moveInput);
    if (!res) throw new Error("Illegal move.");

    this._saveSnapshot();

    const moveData = {
      fen: this.chess.fen(),
      san: res.san,
      uci: res.from + res.to + (res.promotion || ""),
      move: res,
      color: this.userColor,
      eval: null,
      classification: null,
      feedback: null,
      timestamp: Date.now(),
    };

    this.history.push(moveData);
    this.currentHintLevel = 0;

    this._checkGameEnd();
    return moveData;
  }

  /**
   * Select best or randomized move for the coach according to strength settings.
   */
  selectCoachMove(engineAnalysis) {
    if (!engineAnalysis || !engineAnalysis.lines || engineAnalysis.lines.length === 0) {
      if (engineAnalysis && engineAnalysis.bestmove) {
        return engineAnalysis.bestmove;
      }
      // Fallback: pick any legal move
      const moves = this.chess.moves({ verbose: true });
      if (!moves.length) return null;
      const m = moves[Math.floor(Math.random() * moves.length)];
      return m.from + m.to + (m.promotion || "");
    }

    const config = COACH_STRENGTHS[this.strength] || COACH_STRENGTHS.intermediate;
    const lines = engineAnalysis.lines.filter((l) => l && l.pv);
    if (!lines.length) return engineAnalysis.bestmove;

    // At expert/advanced level, always play top choice
    if (this.strength === "expert" || this.strength === "advanced" || lines.length === 1) {
      const topPv = lines[0].pv.split(" ")[0];
      return topPv || engineAnalysis.bestmove;
    }

    // At beginner/casual level, introduce deliberate move variance
    const rand = Math.random();
    if (this.strength === "beginner") {
      if (rand > 0.50 && lines.length > 1) {
        const choice = (rand > 0.80 && lines.length > 2) ? lines[2] : lines[1];
        return choice.pv.split(" ")[0] || lines[0].pv.split(" ")[0];
      }
    } else if (this.strength === "casual") {
      if (rand > 0.70 && lines.length > 1) {
        return lines[1].pv.split(" ")[0] || lines[0].pv.split(" ")[0];
      }
    }

    const topPv = lines[0].pv.split(" ")[0];
    return topPv || engineAnalysis.bestmove;
  }

  /**
   * Apply coach move to board.
   */
  makeCoachMove(uciMove) {
    if (this.status !== "playing") throw new Error("Game is over.");
    if (this.isUserTurn) throw new Error("It's the user's turn.");

    if (!uciMove) {
      const moves = this.chess.moves({ verbose: true });
      if (!moves.length) {
        this._checkGameEnd();
        return null;
      }
      const m = moves[0];
      uciMove = m.from + m.to + (m.promotion || "");
    }

    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const promotion = uciMove.slice(4, 5) || undefined;

    const res = this.chess.move({ from, to, promotion });
    if (!res) throw new Error(`Illegal coach move: ${uciMove}`);

    const moveData = {
      fen: this.chess.fen(),
      san: res.san,
      uci: uciMove,
      move: res,
      color: this.userColor === "w" ? "b" : "w",
      eval: null,
      classification: null,
      feedback: null,
      timestamp: Date.now(),
    };

    this.history.push(moveData);
    this._checkGameEnd();
    return moveData;
  }

  /**
   * Take back user move and coach response (or single move if user turn was last).
   */
  takeback() {
    if (!this.settings.allowTakebacks) throw new Error("Takebacks are disabled.");
    if (this.undoStack.length <= 1) return false;

    // Pop current state
    this.undoStack.pop();
    const snap = this.undoStack[this.undoStack.length - 1];

    // Restore state
    this.chess.load(snap.fen);
    this.history = JSON.parse(JSON.stringify(snap.history));
    this.status = snap.status;
    this.gameResult = snap.gameResult ? { ...snap.gameResult } : null;
    this.lastThreat = snap.lastThreat;
    this.lastFeedback = snap.lastFeedback;
    this.currentHintLevel = 0;
    this.requestId++;

    return true;
  }

  /**
   * Resign game.
   */
  resign() {
    if (this.status === "ended") return;
    this.status = "ended";
    this.gameResult = {
      winner: "coach",
      reason: "resignation",
      text: "Game over — You resigned.",
    };
  }

  _checkGameEnd() {
    const isCheckmate = typeof this.chess.isCheckmate === "function" ? this.chess.isCheckmate() : (typeof this.chess.in_checkmate === "function" ? this.chess.in_checkmate() : false);
    const isStalemate = typeof this.chess.isStalemate === "function" ? this.chess.isStalemate() : (typeof this.chess.in_stalemate === "function" ? this.chess.in_stalemate() : false);
    const isThreefold = typeof this.chess.isThreefoldRepetition === "function" ? this.chess.isThreefoldRepetition() : (typeof this.chess.in_threefold_repetition === "function" ? this.chess.in_threefold_repetition() : false);
    const isDraw = typeof this.chess.isDraw === "function" ? this.chess.isDraw() : (typeof this.chess.in_draw === "function" ? this.chess.in_draw() : false);

    if (isCheckmate) {
      this.status = "ended";
      const winner = this.chess.turn() === this.userColor ? "coach" : "user";
      this.gameResult = {
        winner,
        reason: "checkmate",
        text: `Game over — Checkmate! ${winner === "user" ? "You won!" : "Coach won."}`,
      };
    } else if (isStalemate) {
      this.status = "ended";
      this.gameResult = { winner: "draw", reason: "stalemate", text: "Game over — Draw by stalemate." };
    } else if (isThreefold) {
      this.status = "ended";
      this.gameResult = { winner: "draw", reason: "repetition", text: "Game over — Draw by 3-fold repetition." };
    } else if (isDraw) {
      this.status = "ended";
      this.gameResult = { winner: "draw", reason: "draw", text: "Game over — Draw." };
    }
  }

  /**
   * Generate threat description after coach's move.
   */
  detectThreats(prevFen, currentFen) {
    if (!this.settings.showThreats) return null;

    const c = new Chess(currentFen);
    const inCheck = typeof c.isCheck === "function" ? c.isCheck() : (typeof c.in_check === "function" ? c.in_check() : false);
    if (inCheck) {
      return "Check! Your king is under direct attack.";
    }

    const turn = c.turn(); // Turn is now user's
    if (turn !== this.userColor) return null;

    const board = c.board();
    const threats = [];

    for (let r = 0; r < 8; r++) {
      for (let col = 0; col < 8; col++) {
        const piece = board[r][col];
        if (piece && piece.color === this.userColor && piece.type !== "k") {
          const sq = String.fromCharCode(97 + col) + (8 - r);
          const isAttacked = typeof c.isAttacked === "function" ? c.isAttacked(sq, this.userColor === "w" ? "b" : "w") : (typeof c.square_is_attacked === "function" ? c.square_is_attacked(sq, this.userColor === "w" ? "b" : "w") : false);
          if (isAttacked) {
            const pieceName = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" }[piece.type];
            threats.push(`Your ${pieceName} on ${sq} is attacked.`);
          }
        }
      }
    }

    if (threats.length > 0) {
      this.lastThreat = threats[0];
      return threats[0];
    }

    this.lastThreat = null;
    return null;
  }

  /**
   * Get progressive hint (Levels 1 to 4).
   */
  getHint(engineAnalysis) {
    if (!this.settings.enableHints) return null;
    if (this.status !== "playing" || !this.isUserTurn) return null;

    this.currentHintLevel = Math.min(4, this.currentHintLevel + 1);

    const bestmove = engineAnalysis?.bestmove || (this.chess.moves({ verbose: true })[0]?.from + this.chess.moves({ verbose: true })[0]?.to);
    if (!bestmove) return { level: this.currentHintLevel, text: "No moves available." };

    const fromSq = bestmove.slice(0, 2);
    const toSq = bestmove.slice(2, 4);
    const piece = this.chess.get(fromSq);
    const pieceName = piece ? { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[piece.type] : "piece";

    const inCheck = typeof this.chess.isCheck === "function" ? this.chess.isCheck() : (typeof this.chess.in_check === "function" ? this.chess.in_check() : false);

    switch (this.currentHintLevel) {
      case 1:
        if (inCheck) return { level: 1, text: "Your king is in check — look for ways to step out, block, or capture." };
        if (piece && (piece.type === "n" || piece.type === "b") && (fromSq[1] === "1" || fromSq[1] === "8")) {
          return { level: 1, text: "Focus on piece development and controlling key squares." };
        }
        return { level: 1, text: "Look for opportunities to improve piece activity or king safety." };
      case 2:
        return { level: 2, text: `Consider moving your ${pieceName} or acting around square ${fromSq}.` };
      case 3:
        return { level: 3, text: `Look at square ${toSq} for your ${pieceName} on ${fromSq}.` };
      case 4:
      default:
        return { level: 4, text: `Best move: ${pieceName.toUpperCase()} from ${fromSq} to ${toSq}.` };
    }
  }

  /**
   * Summarize user performance stats at game end.
   */
  getSummaryStats() {
    const userMoves = this.history.filter((h) => h.color === this.userColor);
    const counts = { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    let totalEvalLoss = 0;

    userMoves.forEach((m) => {
      if (m.classification && counts[m.classification] !== undefined) {
        counts[m.classification]++;
      }
      if (m.evalLoss) totalEvalLoss += Math.max(0, m.evalLoss);
    });

    const avgLoss = userMoves.length ? (totalEvalLoss / userMoves.length).toFixed(1) : 0;
    const estAccuracy = userMoves.length
      ? Math.max(20, Math.min(100, Math.round(100 - (totalEvalLoss / userMoves.length) * 15)))
      : 100;

    return {
      totalMoves: userMoves.length,
      counts,
      estAccuracy,
      avgLoss,
      result: this.gameResult,
      pgn: this.pgn,
    };
  }
}
