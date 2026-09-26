import { describe, it, expect, beforeEach } from "vitest";
import { PlayCoachGame, COACH_STRENGTHS, COACH_PERSONALITIES } from "./play-coach.js";

describe("Play Coach Mode - Core Logic & Rules", () => {
  let game;

  beforeEach(() => {
    game = new PlayCoachGame({
      userColor: "w",
      strength: "intermediate",
      coachId: "mentor",
      settings: {
        showEval: true,
        showThreats: true,
        enableHints: true,
        allowTakebacks: true,
      },
    });
  });

  it("initializes game state correctly for White user", () => {
    expect(game.userColor).toBe("w");
    expect(game.isUserTurn).toBe(true);
    expect(game.status).toBe("playing");
    expect(game.history.length).toBe(0);
    expect(game.fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  });

  it("supports random color selection", () => {
    const randomGame = new PlayCoachGame({ userColor: "random" });
    expect(["w", "b"]).toContain(randomGame.userColor);
  });

  it("allows legal user move and updates turn", () => {
    const move = game.makeUserMove({ from: "e2", to: "e4" });
    expect(move.san).toBe("e4");
    expect(game.history.length).toBe(1);
    expect(game.isUserTurn).toBe(false); // Now coach's turn (Black)
  });

  it("prevents illegal user moves", () => {
    expect(() => game.makeUserMove({ from: "e2", to: "e5" })).toThrow();
  });

  it("allows coach move and restores user turn", () => {
    game.makeUserMove("e4");
    const coachMove = game.makeCoachMove("e7e5");
    expect(coachMove.san).toBe("e5");
    expect(game.history.length).toBe(2);
    expect(game.isUserTurn).toBe(true);
  });

  it("supports engine strength mapping and move selection", () => {
    game.makeUserMove("e4");
    const dummyAnalysis = {
      bestmove: "e7e5",
      lines: [
        { score: { cp: 20 }, pv: "e7e5 g1f3" },
        { score: { cp: 0 }, pv: "c7c5 g1f3" },
        { score: { cp: -50 }, pv: "e7e6 d2d4" },
      ],
    };

    const selectedMove = game.selectCoachMove(dummyAnalysis);
    expect(selectedMove).toBeTruthy();
    expect(["e7e5", "c7c5", "e7e6"]).toContain(selectedMove);
  });

  it("supports takebacks and restores exact board state", () => {
    game.makeUserMove("e4");
    game.makeCoachMove("e7e5");
    expect(game.history.length).toBe(2);

    const success = game.takeback();
    expect(success).toBe(true);
    expect(game.history.length).toBe(0);
    expect(game.fen).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(game.isUserTurn).toBe(true);
  });

  it("prevents takeback if disabled in settings", () => {
    const noTakebackGame = new PlayCoachGame({
      userColor: "w",
      settings: { allowTakebacks: false },
    });
    noTakebackGame.makeUserMove("e4");
    expect(() => noTakebackGame.takeback()).toThrow();
  });

  it("provides 4 progressive hint levels", () => {
    game.makeUserMove("e4");
    game.makeCoachMove("e7e5");

    const dummyAnalysis = { bestmove: "g1f3", score: { cp: 30 } };

    const h1 = game.getHint(dummyAnalysis);
    expect(h1.level).toBe(1);

    const h2 = game.getHint(dummyAnalysis);
    expect(h2.level).toBe(2);

    const h3 = game.getHint(dummyAnalysis);
    expect(h3.level).toBe(3);

    const h4 = game.getHint(dummyAnalysis);
    expect(h4.level).toBe(4);
    expect(h4.text).toContain("KNIGHT");
  });

  it("detects threats when enabled", () => {
    const blackGame = new PlayCoachGame({ userColor: "b" });
    // White played Bc4, Qh5 threatening Qxf7+
    const threat = blackGame.detectThreats(
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3",
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
    );
    expect(threat).toBeTruthy();
    expect(threat).toContain("pawn");
  });

  it("handles game resignation", () => {
    game.resign();
    expect(game.status).toBe("ended");
    expect(game.gameResult.reason).toBe("resignation");
  });

  it("generates user performance summary at game end", () => {
    game.makeUserMove("e4");
    game.makeCoachMove("e7e5");
    game.resign();

    const summary = game.getSummaryStats();
    expect(summary.totalMoves).toBe(1);
    expect(summary.result.reason).toBe("resignation");
    expect(summary.pgn).toContain("1. e4 e5");
  });

  it("exposes valid coach strength levels and personalities list", () => {
    expect(Object.keys(COACH_STRENGTHS)).toEqual(["beginner", "casual", "intermediate", "advanced", "expert"]);
    expect(COACH_PERSONALITIES.length).toBeGreaterThan(5);
  });
});
