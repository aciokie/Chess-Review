import { Chess } from "../lib/chess.js";

// Provisional UI evidence has its own cache. Never repair or replace the completed
// search result with a previous coherent iteration.
export class CoherentProgress {
  constructor(fen, multipv) {
    this.legal = new Set(new Chess(fen).moves({ verbose: true }).map(move => move.lan));
    this.count = Math.min(multipv, this.legal.size);
    this.lines = new Map();
    this.lastDepth = -1;
    this.signature = null;
  }

  observe(text) {
    if (!text.startsWith("info ") || !text.includes(" score ")) return null;
    const rank = Number(/\bmultipv (\S+)/.exec(text)?.[1] || 1);
    const depth = Number(/\bdepth (\S+)/.exec(text)?.[1] || 0);
    const value = /\bscore (cp|mate) (\S+)/.exec(text);
    // Even a bounded/invalid rank 1 closes the preceding group. Equal depth
    // does not mean that cached secondary lines belong to this new iteration.
    if (rank === 1) this.lines.clear();
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > this.count) return null;
    const wdl = /\bwdl (\d+) (\d+) (\d+)/.exec(text);
    const score = value && /^-?\d+$/.test(value[2]) && Number.isSafeInteger(Number(value[2]))
      && (value[1] !== "mate" || Number(value[2]) !== 0)
      ? { [value[1]]: Number(value[2]), ...(wdl ? { wdl: wdl.slice(1).map(Number) } : {}) } : null;
    const bound = /\b(lowerbound|upperbound)\b/.exec(text)?.[1] || "exact";
    const pv = text.split(" pv ")[1]?.trim() || "";
    this.lines.set(rank, { multipv: rank, depth, score, bound, pv });
    const lines = Array.from({ length: this.count }, (_, i) => this.lines.get(i + 1));
    const top = lines[0];
    if (!top || lines.some(line => !line || !line.score || line.bound !== "exact"
      || !Number.isSafeInteger(line.depth) || line.depth < 4 || line.depth !== top.depth)) return null;
    const moves = lines.map(line => line.pv.split(" ")[0]);
    if (new Set(moves).size !== this.count || moves.some(move => !this.legal.has(move))
      || top.depth < this.lastDepth) return null;
    const signature = JSON.stringify(lines);
    if (signature === this.signature) return null;
    this.signature = signature;
    this.lastDepth = top.depth;
    return structuredClone({ bestmove: moves[0], score: top.score, pv: top.pv, lines });
  }
}
