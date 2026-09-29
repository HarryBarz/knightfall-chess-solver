"use strict";

// A wall-clock anchor keeps background tabs and page reloads from stopping time.
// This module knows move history, but leaves chess legality to the game server.
(() => {
  const VERSION = 1;
  const INITIAL_MS = 10 * 60 * 1000;
  const MAX_PLIES = 4096;
  const MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  const COLORS = ["white", "black"];
  const other = (color) => color === "white" ? "black" : "white";
  const copyBalances = (balances) => ({ white: balances.white, black: balances.black });
  const timestamp = (value) => Number.isFinite(value) && value >= 0;
  const balancesValid = (value) => value && COLORS.every((color) =>
    Number.isFinite(value[color]) && value[color] >= 0 && value[color] <= INITIAL_MS);
  const movesValid = (moves) => Array.isArray(moves) && moves.length <= MAX_PLIES
    && moves.every((move) => typeof move === "string" && MOVE.test(move) && move.slice(0, 2) !== move.slice(2, 4));
  const sameMoves = (first, second) => first.length === second.length && first.every((move, index) => move === second[index]);
  const isPrefix = (prefix, moves) => prefix.length <= moves.length && prefix.every((move, index) => move === moves[index]);

  function initialTurn(fen) {
    if (typeof fen !== "string" || fen.length > 512) throw new TypeError("A game clock needs its initial FEN.");
    const fields = fen.trim().split(/\s+/);
    if (fields.length !== 6 || !/^[wb]$/.test(fields[1])) throw new TypeError("Invalid initial FEN for the game clock.");
    const ranks = fields[0].split("/");
    if (ranks.length !== 8 || ranks.some((rank) => !/^[prnbqkPRNBQK1-8]+$/.test(rank)
      || Array.from(rank).reduce((sum, char) => sum + (/[1-8]/.test(char) ? Number(char) : 1), 0) !== 8)) {
      throw new TypeError("Invalid initial FEN for the game clock.");
    }
    return fields[1] === "w" ? "white" : "black";
  }

  class GameClock {
    constructor(initialFen, moves = [], options = {}) {
      this._initialTurn = initialTurn(initialFen);
      if (!movesValid(moves)) throw new TypeError("Invalid move history for the game clock.");
      this._now = options.now || (() => Date.now());
      if (typeof this._now !== "function") throw new TypeError("The clock time source must be a function.");
      const now = this._time();
      this.initialFen = initialFen;
      this.moves = moves.slice();
      this.basePly = moves.length;
      this._remaining = { white: INITIAL_MS, black: INITIAL_MS };
      this._turn = this._colorAt(moves.length);
      this._running = false;
      this._flagged = null;
      this._anchor = now;
      this._history = [{ ply: moves.length, remaining: copyBalances(this._remaining) }];
      if (options.saved && this._validSaved(options.saved, now)) this._load(options.saved, now);
    }

    get turn() { return this._turn; }
    get running() { return this._running; }
    get flagged() { return this._flagged; }
    get ply() { return this.moves.length; }

    _time(at = this._now()) {
      if (!timestamp(at)) throw new TypeError("Clock timestamps must be finite and nonnegative.");
      return at;
    }

    _colorAt(ply) { return ply % 2 ? other(this._initialTurn) : this._initialTurn; }

    _advance(at) {
      at = this._time(at);
      // A backwards system clock must not refund time or count an interval twice.
      const elapsed = Math.max(0, at - this._anchor);
      this._anchor = Math.max(at, this._anchor);
      if (this._running && !this._flagged) {
        this._remaining[this._turn] = Math.max(0, this._remaining[this._turn] - elapsed);
        if (this._remaining[this._turn] === 0) {
          this._flagged = this._turn;
          this._running = false;
        }
      }
    }

    _state() {
      return {
        version: VERSION, initialFen: this.initialFen, moves: this.moves.slice(),
        basePly: this.basePly, ply: this.ply, remaining: copyBalances(this._remaining),
        turn: this._turn, running: this._running, flagged: this._flagged, anchor: this._anchor,
        history: this._history.map((entry) => ({ ply: entry.ply, remaining: copyBalances(entry.remaining) })),
      };
    }

    settle(at = this._now()) { this._advance(at); return this._state(); }
    snapshot(at = this._now()) { return this.settle(at); }
    serialize(at = this._now()) { return this.settle(at); }

    resume(at = this._now()) {
      this._advance(at);
      if (!this._flagged) this._running = true;
      return this._state();
    }

    start(at = this._now()) { return this.resume(at); }

    pause(at = this._now()) {
      this._advance(at);
      this._running = false;
      return this._state();
    }

    remaining(color, at = this._now()) {
      color = color === "w" ? "white" : color === "b" ? "black" : color;
      if (!COLORS.includes(color)) throw new TypeError("Clock color must be White or Black.");
      this._advance(at);
      return this._remaining[color];
    }

    commit(nextMoves, at = this._now()) {
      // Settle even a failed attempt: invalid or late moves cannot stop the clock.
      this._advance(at);
      if (this._flagged || !movesValid(nextMoves) || nextMoves.length !== this.moves.length + 1
        || !isPrefix(this.moves, nextMoves)) return false;
      this.moves = nextMoves.slice();
      this._turn = this._colorAt(this.moves.length);
      this._history.push({ ply: this.ply, remaining: copyBalances(this._remaining) });
      return true;
    }

    undo(prefixMoves, at = this._now()) {
      this._advance(at);
      if (this._flagged || !movesValid(prefixMoves) || prefixMoves.length >= this.moves.length
        || !isPrefix(prefixMoves, this.moves)) return false;
      const entry = this._history.find((saved) => saved.ply === prefixMoves.length);
      if (entry) {
        for (const color of COLORS) this._remaining[color] = Math.min(this._remaining[color], entry.remaining[color]);
        this._history = this._history.filter((saved) => saved.ply <= prefixMoves.length);
      } else {
        // Imported moves have no timed history. Keep the actual remaining time
        // and establish a new baseline instead of inventing earlier clock values.
        this.basePly = prefixMoves.length;
        this._history = [{ ply: prefixMoves.length, remaining: copyBalances(this._remaining) }];
      }
      this.moves = prefixMoves.slice();
      this._turn = this._colorAt(this.moves.length);
      return true;
    }

    _validSaved(saved, now) {
      if (!saved || saved.version !== VERSION || saved.initialFen !== this.initialFen
        || !movesValid(saved.moves) || !sameMoves(saved.moves, this.moves)
        || !Number.isInteger(saved.basePly) || saved.basePly < 0 || saved.basePly > this.ply
        || saved.ply !== this.ply || saved.turn !== this._turn || typeof saved.running !== "boolean"
        || !timestamp(saved.anchor) || saved.anchor > now || !balancesValid(saved.remaining)
        || !Array.isArray(saved.history) || saved.history.length !== this.ply - saved.basePly + 1) return false;
      if (saved.flagged !== null) {
        if (saved.flagged !== saved.turn || saved.running || saved.remaining[saved.turn] !== 0
          || saved.remaining[other(saved.turn)] <= 0) return false;
      } else if (COLORS.some((color) => saved.remaining[color] <= 0)) return false;
      let previous = { white: INITIAL_MS, black: INITIAL_MS };
      for (let index = 0; index < saved.history.length; index++) {
        const entry = saved.history[index];
        if (!entry || entry.ply !== saved.basePly + index || !balancesValid(entry.remaining)
          || COLORS.some((color) => entry.remaining[color] <= 0 || entry.remaining[color] > previous[color])) return false;
        previous = entry.remaining;
      }
      return COLORS.every((color) => saved.remaining[color] <= previous[color]);
    }

    _load(saved, now) {
      this.basePly = saved.basePly;
      this._remaining = copyBalances(saved.remaining);
      this._running = saved.running;
      this._flagged = saved.flagged;
      this._anchor = saved.anchor;
      this._history = saved.history.map((entry) => ({ ply: entry.ply, remaining: copyBalances(entry.remaining) }));
      this._advance(now);
    }

    static restore(saved, initialFen, moves = [], options = {}) {
      try {
        const clock = new GameClock(initialFen, moves, { now: options.now });
        const now = clock._anchor;
        if (!clock._validSaved(saved, now)) return null;
        clock._load(saved, now);
        return clock;
      } catch {
        return null;
      }
    }
  }

  const api = Object.freeze({ GameClock, INITIAL_MS, VERSION });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.KnightfallGameClock = api;
})();
