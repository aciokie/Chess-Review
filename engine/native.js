// engine/native.js — extension-side adapter for the Chess Review native engine helper.
//
// The helper is an optional, per-user Native Messaging host (see native/README.md). It launches a
// genuine native Stockfish executable and speaks UCI to it. This adapter deliberately exposes the
// SAME surface as engine/uci.js (the bundled WASM wrapper) so createEngine()/analysis.js can swap
// between the two without touching the classification, accuracy or UI code:
//
//   await eng.setOptions({Hash, "Skill Level"})           // handshake (rejects when the host is missing)
//   await eng.analyse(fen, depth, multipv, history)       // -> {bestmove, score, pv, lines}
//   eng.stop() / eng.cancelPending() / eng.terminate() / eng.dead / eng.buildKey
//
// Everything the host sends back is validated here: a Native Messaging reply is not trusted just
// because it arrived on the port. Bad frames are dropped; a fatal one fails the engine so the
// caller falls back down the build chain.

import { browserAPI } from "../browser-compat.js";

// The host name registered on the user's machine (native/install.ps1). Chrome/Brave/Edge/Firefox
// launch the helper lazily on connectNative() and tear it down when the port closes.
export const NATIVE_HOST_NAME = "com.chessreview.native_engine";
// The helper answers `hello` immediately on start — before it launches Stockfish — so the settings
// tab can show availability without paying for (or accidentally starting) an engine.
// 15 s, not a few seconds: antivirus (Avast CyberCapture, Defender) can hold a never-seen .exe for
// several seconds on its first launch, and a probe that gives up too early reports a perfectly
// installed helper as "not detected".
export const NATIVE_HELLO_TIMEOUT_MS = 15000;
// Host start + Stockfish `uci`/`isready` handshake. This is a PER-PHASE budget: one phase for the
// helper process to come up, then a fresh phase for the engine it launches. The first launch on a
// machine with antivirus can be blocked for a long time while the executables are scanned (the
// repo already allows 60 s for the large WASM build), so each phase gets the same generous budget.
// A stuck host still rejects, so the review falls back to WASM instead of hanging forever.
export const NATIVE_INIT_TIMEOUT_MS = 60000;
// A silent search must not hang the review forever (mirrors engine/uci.js SEARCH_SILENCE_TIMEOUT_MS).
export const NATIVE_SEARCH_SILENCE_TIMEOUT_MS = 120000;
// Cap on the payload we will accept from (or send to) the host. Real replies are a few KB; this
// only exists so a corrupted/buggy host can't wedge the page with an enormous frame.
export const NATIVE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const HOST_MESSAGE_TYPES = new Set(["hello", "ready", "pong", "info", "bestmove", "error"]);

/** Is the Native Messaging API present in this browser context? (Absent in page-world/tests.) */
export function nativeMessagingSupported(runtime = browserAPI?.runtime) {
  return !!runtime && typeof runtime.connectNative === "function";
}

function lastErrorMessage(runtime) {
  try { return runtime?.lastError?.message || null; } catch { return null; }
}

function asInt(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeScore(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.cp != null) { const cp = asInt(raw.cp, -100000, 100000); if (cp !== null) return { cp }; }
  if (raw.mate != null) { const mate = asInt(raw.mate, -1000, 1000); if (mate !== null) return { mate }; }
  return null;
}

function normalizeLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const score = normalizeScore(raw.score);
  if (!score) return null;
  return {
    score,
    pv: typeof raw.pv === "string" ? raw.pv.slice(0, 4096) : "",
    depth: asInt(raw.depth, 0, 512) ?? 0,
    bound: raw.bound === "lowerbound" || raw.bound === "upperbound" ? raw.bound : "exact",
    multipv: asInt(raw.multipv, 1, 500) ?? 1,
  };
}

/** Reject anything that isn't a well-formed host message. Returns null when the frame is unusable. */
function normalizeHostMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.type !== "string" || !HOST_MESSAGE_TYPES.has(raw.type)) return null;
  const out = { type: raw.type };
  if (raw.id !== undefined && raw.id !== null) {
    out.id = typeof raw.id === "number" ? raw.id : String(raw.id).slice(0, 64);
  }
  if (typeof raw.message === "string") out.message = raw.message.slice(0, 2000);
  if (raw.fatal === true) out.fatal = true;
  if (typeof raw.version === "string") out.version = raw.version.slice(0, 40);
  if (typeof raw.engineConfigured === "boolean") out.engineConfigured = raw.engineConfigured;
  if (raw.engine && typeof raw.engine === "object") {
    out.engine = {
      name: typeof raw.engine.name === "string" ? raw.engine.name.slice(0, 120) : null,
      verified: raw.engine.verified === true,
    };
    // Diagnostics material from the helper: the engine binary's SHA-256 and whether it matches the
    // hash pinned in config.json. Optional — older helpers simply omit them.
    if (typeof raw.engine.sha256 === "string") out.engine.sha256 = raw.engine.sha256.slice(0, 64);
    if (typeof raw.engine.hashVerified === "boolean") out.engine.hashVerified = raw.engine.hashVerified;
  }
  if (raw.type === "info") {
    out.lines = Array.isArray(raw.lines) ? raw.lines.slice(0, 32).map(normalizeLine).filter(Boolean) : [];
  }
  if (raw.type === "bestmove") {
    out.bestmove = typeof raw.bestmove === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(raw.bestmove)
      ? raw.bestmove : null;
    out.score = normalizeScore(raw.score) || { cp: 0 };
    out.pv = typeof raw.pv === "string" ? raw.pv.slice(0, 4096) : "";
    out.lines = Array.isArray(raw.lines) ? raw.lines.slice(0, 32).map(normalizeLine).filter(Boolean) : [];
  }
  return out;
}

/** Only primitives, no control characters — these end up on Stockfish's stdin as UCI options. */
function sanitizeOptions(opts) {
  const clean = {};
  for (const [name, value] of Object.entries(opts || {})) {
    if (value === null || value === undefined) continue;
    if (!/^[\x20-\x7e]{1,64}$/.test(name)) continue;
    const text = String(value);
    if (!/^[\x20-\x7e]{0,128}$/.test(text)) continue;
    clean[name] = text;
  }
  return clean;
}

/**
 * Is the native helper installed and reachable? Connects, waits for the helper's `hello` (which it
 * sends before starting any engine) and disconnects. Never launches Stockfish and never leaves a
 * process behind. Resolves — it does not reject — so callers can render the result directly.
 */
export function probeNativeHost({ runtime = browserAPI?.runtime, hostName = NATIVE_HOST_NAME, timeoutMs = NATIVE_HELLO_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!nativeMessagingSupported(runtime)) { resolve({ available: false, reason: "unsupported" }); return; }
    let port = null, settled = false;
    const finish = (result, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = reason ?? lastErrorMessage(runtime);
      try { port?.disconnect(); } catch {}
      resolve(message ? { ...result, message: String(message).slice(0, 300) } : result);
    };
    const timer = setTimeout(() => finish({ available: false, reason: "timeout" }), Math.max(250, timeoutMs));
    try { port = runtime.connectNative(hostName); }
    catch (e) { finish({ available: false, reason: "connect-failed" }, e?.message || String(e)); return; }
    if (!port) { finish({ available: false, reason: "connect-failed" }, "connectNative returned no port"); return; }
    port.onMessage.addListener((raw) => {
      const msg = normalizeHostMessage(raw);
      if (!msg || msg.type !== "hello") return;
      finish({
        available: true,
        engineConfigured: msg.engineConfigured !== false,
        version: msg.version || null,
        engine: msg.engine || null,
      });
    });
    port.onDisconnect.addListener(() => finish({ available: false, reason: "disconnected" }));
  });
}

/**
 * Native-engine adapter with the engine/uci.js contract. One instance == one helper process == one
 * Stockfish executable (the helper refuses to start a second engine), so a review that asks for N
 * workers gets exactly N helper processes — never an accidental extra one.
 */
export class NativeEngine {
  constructor({
    runtime = browserAPI?.runtime,
    hostName = NATIVE_HOST_NAME,
    uciOptions = {},
    initTimeoutMs = NATIVE_INIT_TIMEOUT_MS,
    silenceMs = NATIVE_SEARCH_SILENCE_TIMEOUT_MS,
  } = {}) {
    this.runtime = runtime;
    this.hostName = hostName;
    this.initTimeoutMs = initTimeoutMs;
    this.silenceMs = silenceMs;
    this.dead = false;
    this.port = null;
    this.queue = [];
    this.current = null;
    this.multipv = 1;
    this.buildKey = null;
    this.engineInfo = null;   // { name, verified } reported by the helper once Stockfish is up
    this.hello = null;
    this._nextId = 0;
    this._onReady = null;
    this._onFail = null;

    if (!nativeMessagingSupported(runtime)) {
      this._rejectReady(new Error(`native messaging is unavailable in this browser (${hostName})`));
      return;
    }
    try {
      this.port = runtime.connectNative(hostName);
    } catch (e) {
      this._rejectReady(new Error(`native host could not be started (${hostName}): ${e?.message || e}`));
      return;
    }
    if (!this.port) {
      this._rejectReady(new Error(`native host could not be started (${hostName})`));
      return;
    }
    this.port.onMessage.addListener((msg) => this._onMessage(msg));
    this.port.onDisconnect.addListener(() => this._onDisconnect());
    this._ready = this._handshake(uciOptions);
    this._ready.catch(() => {}); // pre-attach: an unconsumed handshake (nobody awaited) must not warn
  }

  _rejectReady(err) {
    this.dead = true;
    this._ready = Promise.reject(err);
    this._ready.catch(() => {}); // pre-attach so an unconsumed rejection never warns
  }

  _handshake(uciOptions) {
    return new Promise((resolve, reject) => {
      this._onReady = resolve;
      this._onFail = reject;
      this._initTimer = setTimeout(
        () => this._fail(new Error(`native engine handshake timed out (${this.hostName})`)),
        this.initTimeoutMs,
      );
      this._post({ type: "init", options: sanitizeOptions(uciOptions) });
    });
  }

  /** Tear down after any fatal condition (timeout, disconnect, crash, explicit terminate). */
  _fail(err) {
    clearTimeout(this._initTimer);
    clearTimeout(this._searchTimer);
    const handshake = this._onFail;
    this.dead = true;
    try { this.port?.disconnect(); } catch {}
    this.port = null;
    if (handshake) {
      this._onReady = null;
      this._onFail = null;
      try { handshake(err); } catch {}
    }
    if (this.current) { try { this.current.reject(err); } catch {} this.current = null; }
    while (this.queue.length) { const job = this.queue.shift(); try { job.reject(err); } catch {} }
  }

  _onDisconnect() {
    if (this.dead) return;
    const reason = lastErrorMessage(this.runtime);
    this._fail(new Error(reason ? `native engine disconnected: ${reason}` : "native engine disconnected"));
  }

  _post(msg) {
    if (this.dead || !this.port) return false;
    try { this.port.postMessage(msg); return true; }
    catch (e) { this._fail(new Error(`native message failed: ${e?.message || e}`)); return false; }
  }

  /** The host applies `options` during init; this stays for API parity (and for later changes). */
  async setOptions(opts = {}) {
    await this._ready;
    if (this.dead) throw new Error("native engine is no longer running");
    for (const [name, value] of Object.entries(sanitizeOptions(opts))) {
      this._post({ type: "setoption", name, value });
    }
  }

  /** Abort the ongoing search (Stockfish answers `bestmove` quickly) — used by live analysis. */
  stop() {
    if (this.dead) return;
    this._post(this.current ? { type: "stop", id: this.current.id } : { type: "stop" });
  }

  /** Discard obsolete queued live searches without interrupting their Promise callers. */
  cancelPending() {
    const err = new Error("analysis superseded");
    while (this.queue.length) { try { this.queue.shift().reject(err); } catch {} }
  }

  _watchSearch() {
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._fail(new Error("native engine search timed out")), this.silenceMs);
  }

  _pump() {
    if (this.dead || this.current || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.current = job;
    this._watchSearch();
    if (job.multipv !== this.multipv) {
      this.multipv = job.multipv;
      this._post({ type: "setoption", name: "MultiPV", value: String(job.multipv) });
    }
    const replay = job.history && job.history.initialFen && Array.isArray(job.history.moves) && job.history.moves.length
      ? { initialFen: job.history.initialFen, moves: job.history.moves } : null;
    this._post({ type: "analyse", id: job.id, fen: job.fen, depth: job.depth, multipv: job.multipv, history: replay });
  }

  /**
   * Analyze one position. Same contract as Engine.analyse: resolves to
   * { bestmove, score:{cp|mate}, pv, lines:[{score,pv,depth,bound,multipv}] } sorted best→worst.
   */
  async analyse(fen, depth = 12, multipv = 1, history = null) {
    await this._ready;
    if (this.dead) throw new Error("native engine is no longer running");
    return new Promise((resolve, reject) => {
      const id = ++this._nextId;
      this.queue.push({ id, fen, depth, multipv, history, resolve, reject, lines: {}, lastScore: null, lastPv: "" });
      this._pump();
    });
  }

  _onMessage(raw) {
    if (this.dead) return;
    const msg = normalizeHostMessage(raw);
    if (!msg) return;
    if (msg.type === "hello") {
      this.hello = msg;
      if (msg.engine) this.engineInfo = msg.engine;
      // The helper is up. Start a fresh phase budget for the engine it is about to launch, so a slow
      // first launch (antivirus scanning Stockfish) doesn't eat the time budgeted for the host start.
      clearTimeout(this._initTimer);
      this._initTimer = setTimeout(
        () => this._fail(new Error(`native engine handshake timed out (${this.hostName})`)),
        this.initTimeoutMs,
      );
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "ready") {
      if (msg.engine) this.engineInfo = msg.engine;
      if (!this._onReady) return;
      clearTimeout(this._initTimer);
      const ready = this._onReady;
      this._onReady = null;
      this._onFail = null;
      ready();
      this._pump();
      return;
    }
    if (msg.type === "info") {
      const job = this.current;
      if (!job || msg.id !== job.id) return;
      this._watchSearch();
      for (const line of msg.lines) {
        job.lines[line.multipv] = line;
        if (line.multipv === 1) { job.lastScore = line.score; if (line.pv) job.lastPv = line.pv; }
      }
      return;
    }
    if (msg.type === "bestmove") {
      const job = this.current;
      if (!job || msg.id !== job.id) return; // answer for a search we already dropped
      this.current = null;
      clearTimeout(this._searchTimer);
      const lines = Object.keys(job.lines).map(Number).sort((a, b) => a - b).map((k) => job.lines[k]);
      job.resolve({
        bestmove: msg.bestmove,
        score: job.lastScore || msg.score || { cp: 0 },
        pv: job.lastPv || msg.pv || "",
        lines: lines.length ? lines : msg.lines,
      });
      this._pump();
      return;
    }
    if (msg.type === "error") {
      const err = new Error(msg.message || "native engine error");
      if (msg.fatal) { this._fail(err); return; }
      const job = this.current;
      if (job && (msg.id == null || msg.id === job.id)) {
        this.current = null;
        clearTimeout(this._searchTimer);
        try { job.reject(err); } catch {}
        this._pump();
      }
    }
  }

  terminate() {
    if (!this.dead) this._post({ type: "quit" });
    this._fail(new Error("engine terminated"));
  }
}