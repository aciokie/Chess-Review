// A cheap, bounded preview of a finished game: one 20,000-node search per position, never the
// review's exact protocol. Used only for the post-game summary on the page; it persists nothing and
// never becomes review evidence. Model, protocol and evidence for real reviews stay untouched.
import { Chess } from "./chess.js";
import { Engine } from "../engine/uci.js";
import { publicMoveQuality, publicGameAccuracy } from "./public-scoring.js";
import { BUTTON_PREVIEW_VERSION, PREVIEW_CATEGORIES } from "./button-preview.js";
import { createImportRequest, checkImport, waitImport } from "./import-request.js";

// The preview budget is deliberate and shared by every platform: 20,000 nodes per search. A depth
// target would make a long game arbitrarily expensive; a node cap keeps one game's preview bounded.
export const PREVIEW_NODES = 20000;
export const PREVIEW_WORKERS = 4;
export const PREVIEW_BUDGET_MS = 90000;

// Parse the finished game, refusing anything the preview cannot honestly score.
export function finishedPreviewGame(pgn) {
  if (typeof pgn !== "string" || !pgn.trim()) throw Error("Game unavailable");
  if (pgn.length > 150000) throw Error("Game unavailable");
  const game = new Chess();
  game.loadPgn(pgn, { strict: true });
  const headers = game.getHeaders();
  if (!/^(1-0|0-1|1\/2-1\/2)$/.test(headers.Result || "")) throw Error("Preview requires a completed game");
  if (headers.FEN || headers.SetUp === "1") throw Error("Unsupported preview position");
  if (headers.Variant && !/^(standard|chess)$/i.test(headers.Variant)) throw Error("Unsupported preview variant");
  const moves = game.history({ verbose: true }).map((move) => move.lan);
  if (!moves.length || moves.length > 1024) throw Error("Unsupported game length");
  return { moves, players: { w: headers.White || "White", b: headers.Black || "Black" } };
}

// Validate the whole game once, and keep an engine position command per root. The engine never
// receives a position that was not replayed move by move here.
class PreviewPositions {
  constructor(moves) {
    const game = new Chess();
    const initialFen = game.fen();
    const prefix = [];
    const commands = new Map();
    const roots = [];
    let bytes = 0;
    for (const played of moves) {
      const legal = game.moves({ verbose: true });
      if (!legal.some((move) => move.lan === played)) throw Error("Invalid preview move");
      const fen = game.fen();
      const command = "position fen " + initialFen + (prefix.length ? " moves " + prefix.join(" ") : "");
      bytes += command.length * 4;
      if (bytes > 4 * 1024 * 1024) throw Error("Preview too large");
      commands.set(fen, command);
      roots.push({ fen, played, color: game.turn(), forced: legal.length === 1 });
      game.move({ from: played.slice(0, 2), to: played.slice(2, 4), promotion: played[4] });
      prefix.push(played);
    }
    this.commands = commands;
    this.roots = roots;
  }
}

// Every search in a preview is a node-budgeted root search; the played move is re-searched at the
// same budget when it was not the engine's first choice, so both numbers are comparable.
class PreviewEngine extends Engine {
  constructor(commands) {
    super("engine/stockfish-nnue.js");
    this.positionCommands = {
      get: (fen) => {
        const command = commands.get(fen);
        if (!command) throw Error("Unvalidated preview position");
        return command;
      },
      clear() {},
    };
  }
}

// Plain single-line category for a preview: the cheap classes only. Mirrors the fallback branch of
// the review's classifier (win%-drop thresholds from calibration.json), so the same move cannot be
// an Inaccuracy in the preview and a Mistake in the review just because of naming.
export function previewCategory({ top, forced, loss }, thresholds = { good: 2, inacc: 5, mistake: 10, blunder: 20 }) {
  if (forced) return "forced";
  if (top) return "best";
  const drop = 100 * (Number.isFinite(loss) ? loss : 0);
  if (drop >= (thresholds.blunder ?? 20)) return "blunder";
  if (drop >= (thresholds.mistake ?? 10)) return "mistake";
  if (drop >= (thresholds.inacc ?? 5)) return "inacc";
  if (drop >= (thresholds.good ?? 2)) return "good";
  return "excellent";
}

function emptyCounts() {
  const counts = {};
  for (const category of PREVIEW_CATEGORIES) counts[category] = 0;
  return counts;
}

async function loadModel(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(new URL("../data/calibration.json", import.meta.url));
  if (!response.ok) throw Error("Calibration unavailable");
  const calibration = await response.json();
  if (!calibration?.quality) throw Error("Calibration unavailable");
  return { quality: calibration.quality, clsWp: calibration.clsWp || { good: 2, inacc: 5, mistake: 10, blunder: 20 } };
}

/**
 * Estimate accuracy and a badge tally for a finished game.
 *
 * @param {string} pgn finished game
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.workers] parallel engines (each one thread, Hash 16)
 * @param {number} [options.budgetMs] whole-preview wall clock before it gives up
 * @param {Function} [options.createEngine] test seam: (commands) => engine
 * @param {Function} [options.loadCalibration] test seam
 */
export async function analyseButtonPreview(pgn, {
  signal,
  workers = PREVIEW_WORKERS,
  budgetMs = PREVIEW_BUDGET_MS,
  createEngine = (commands) => new PreviewEngine(commands),
  loadCalibration = loadModel,
} = {}) {
  const request = createImportRequest(signal, budgetMs);
  const startedAt = Date.now();
  const check = () => {
    checkImport(request.signal);
    if (Date.now() - startedAt > budgetMs) {
      const error = Error("Preview timed out");
      error.code = "PREVIEW_TIMEOUT";
      throw error;
    }
  };
  // A failure to bring up the engine or load its model is an environment problem, not a property of
  // the game, so callers can say so and offer a retry. Cancellations and timeouts keep their code.
  const engineFailure = (error) => {
    if (error && !error.code) error.code = "PREVIEW_ENGINE_UNAVAILABLE";
    return error;
  };
  const engines = [];
  try {
    check();
    const parsed = finishedPreviewGame(pgn);
    const prepared = new PreviewPositions(parsed.moves);
    check();
    let quality, clsWp;
    try {
      ({ quality, clsWp } = await waitImport(loadCalibration(), request.signal));
      if (!quality?.outcome || !quality?.choice) throw Error("Calibration unavailable");
    } catch (error) { throw engineFailure(error); }

    // Forced plies need no search: there was no decision to score. Count and drop them first so the
    // shards only carry real work.
    const counts = { w: emptyCounts(), b: emptyCounts() };
    const decisions = { w: [], b: [] };
    const work = [];
    for (const root of prepared.roots) {
      if (root.forced) { counts[root.color].forced++; continue; }
      work.push(root);
    }

    // One engine per shard. A single-threaded engine per shard keeps every score independent of the
    // machine's core count, exactly like the scored searches.
    const count = Math.max(1, Math.min(work.length || 1, workers));
    for (let index = 0; index < count; index++) {
      try { engines.push(createEngine(prepared.commands)); } catch (error) { throw engineFailure(error); }
    }
    const shards = Array.from({ length: count }, () => []);
    work.forEach((root, index) => shards[index % count].push(root));

    const scoreShard = async (shard, index) => {
      const engine = engines[index];
      if (!shard.length) return;
      await waitImport(engine.setOptions({ Hash: 16, Threads: 1, MultiPV: 1, "Skill Level": 20, UCI_LimitStrength: false, UCI_Chess960: false }), request.signal);
      for (const root of shard) {
        check();
        const budget = { kind: "nodes", value: PREVIEW_NODES };
        const best = await waitImport(engine.analyse(root.fen, PREVIEW_NODES, 1, null, null, { budget }), request.signal);
        const top = best.bestmove === root.played;
        const played = top ? best : await waitImport(
          engine.analyse(root.fen, PREVIEW_NODES, 1, null, null, { budget, searchMove: root.played }), request.signal);
        let decision;
        try { decision = publicMoveQuality(best.score, played.score, quality, { top }); }
        catch { check(); continue; }
        const category = previewCategory({ top, forced: false, loss: decision.loss }, clsWp);
        counts[root.color][category]++;
        decisions[root.color].push(decision);
      }
    };
    try {
      await Promise.all(shards.map(scoreShard));
    } catch (error) { throw engineFailure(error); }
    check();
    return {
      version: BUTTON_PREVIEW_VERSION,
      estimated: true,
      budget: PREVIEW_NODES,
      players: parsed.players,
      accuracy: { w: publicGameAccuracy(decisions.w), b: publicGameAccuracy(decisions.b) },
      counts,
      plies: prepared.roots.length,
      decisions: { w: decisions.w.filter((move) => move.eligible).length, b: decisions.b.filter((move) => move.eligible).length },
    };
  } finally {
    request.dispose();
    for (const engine of engines) { try { engine.terminate(); } catch { /* already gone */ } }
  }
}
