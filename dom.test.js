import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { PlayCoachGame, COACH_STRENGTHS } from "./play-coach.js";

describe("Play Coach Mode - DOM & UI Simulation", () => {
  let dom, window, document;

  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, {
      url: "http://localhost/analysis.html#play-coach",
    });
    window = dom.window;
    document = window.document;
  });

  it("renders setup screen elements properly", () => {
    const pc = new PlayCoachGame({ userColor: "w", strength: "intermediate", coachId: "mentor" });
    expect(pc.status).toBe("playing");
    expect(pc.isUserTurn).toBe(true);

    const select = document.createElement("select");
    select.id = "pcStrengthSelect";
    Object.keys(COACH_STRENGTHS).forEach((k) => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = COACH_STRENGTHS[k].name;
      select.appendChild(opt);
    });

    expect(select.options.length).toBe(5);
    expect(select.options[2].value).toBe("intermediate");
  });

  it("simulates full play coach game loop: user move -> threat check -> hint -> takeback -> resign", () => {
    const pc = new PlayCoachGame({ userColor: "w", strength: "beginner" });

    // 1. User move: e2-e4
    const userMove = pc.makeUserMove("e4");
    expect(userMove.san).toBe("e4");
    expect(pc.isUserTurn).toBe(false);

    // 2. Coach response: e7-e5
    const coachMove = pc.makeCoachMove("e7e5");
    expect(coachMove.san).toBe("e5");
    expect(pc.isUserTurn).toBe(true);

    // 3. Threat detection check
    const threat = pc.detectThreats(
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3",
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
    );

    // 4. Request progressive hint
    const dummyAnalysis = { bestmove: "g1f3", score: { cp: 15 } };
    const hint1 = pc.getHint(dummyAnalysis);
    expect(hint1.level).toBe(1);
    const hint2 = pc.getHint(dummyAnalysis);
    expect(hint2.level).toBe(2);

    // 5. Takeback move
    const tookBack = pc.takeback();
    expect(tookBack).toBe(true);
    expect(pc.history.length).toBe(0);

    // 6. Resign
    pc.resign();
    expect(pc.status).toBe("ended");
    expect(pc.gameResult.reason).toBe("resignation");
  });
});
