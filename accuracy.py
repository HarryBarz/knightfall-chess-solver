"""Local expected-points accuracy estimates from full-strength Stockfish WDL.

The category boundaries follow Chess.com's published expected-points ranges.
The score curve and game average are local estimates, not Chess.com CAPS2.
"""

from __future__ import annotations

from contextlib import suppress
from decimal import Decimal
import math
import threading
import time

import chess
import chess.engine

from coach import CoachError, ExplainService


METHOD_VERSION = "knightfall-ep-v1"
METHOD_NOTE = (
    "Local estimate, not Chess.com CAPS2. Categories use Chess.com's published "
    "expected-points loss ranges. Expected points come from Stockfish's self-play "
    "win/draw/loss model, not Chess.com's player-rating model. Each move is reviewed "
    "at full strength with a bounded search; deeper analysis can change the result. "
    "Move accuracy uses a local exponential curve and each side's report averages "
    "its scored moves equally."
)


class AccuracyError(CoachError):
    pass


def _classification(loss: float) -> str:
    if loss <= 0:
        return "Best"
    if loss < 0.02:
        return "Excellent"
    if loss < 0.05:
        return "Good"
    if loss < 0.10:
        return "Inaccuracy"
    if loss < 0.20:
        return "Mistake"
    return "Blunder"


def _metrics(best: float, played: float) -> dict:
    best = max(best, played)
    # Native WDL expectations have finite decimal precision. Decimal subtraction
    # preserves exact threshold boundaries (e.g. .55 - .50), without rounding loss.
    loss = float(Decimal(str(best)) - Decimal(str(played)))
    accuracy = 100 * (math.exp(-4 * loss) - math.exp(-4)) / (1 - math.exp(-4))
    return {
        "expectedPointsBefore": best, "expectedPointsAfter": played,
        "expectedPointsLoss": loss, "classification": _classification(loss),
        "moveAccuracy": min(100.0, max(0.0, accuracy)),
    }


def _native_candidate(before: chess.Board, info: dict, root_move=None) -> dict | None:
    """Require one coherent exact UCI frame, never a bound or inferred WDL."""
    if info.get("lowerbound") or info.get("upperbound"):
        return None
    pv, score, wdl = info.get("pv"), info.get("score"), info.get("wdl")
    if not pv or score is None or wdl is None or pv[0] not in before.legal_moves:
        return None
    if root_move is not None and pv[0] != root_move:
        return None
    side_wdl = wdl.pov(before.turn)
    if side_wdl.total() != 1000 or min(side_wdl.wins, side_wdl.draws, side_wdl.losses) < 0:
        return None
    white_score = score.white()
    if white_score.score() is None and white_score.mate() is None:
        return None
    return {
        "move": pv[0], "expected": side_wdl.expectation(),
        "wdl": {"wins": side_wdl.wins, "draws": side_wdl.draws, "losses": side_wdl.losses},
        "score": {"cp": white_score.score(), "mate": white_score.mate()},
        "depth": info.get("depth"), "source": "native-wdl",
    }


def _terminal_candidate(before: chess.Board, move: chess.Move) -> dict | None:
    after = before.copy()
    after.push(move)
    outcome = after.outcome(claim_draw=False)
    if outcome is None:
        return None
    expected = 0.5 if outcome.winner is None else float(outcome.winner == before.turn)
    return {
        "move": move, "expected": expected,
        "wdl": {"wins": 1000 if expected == 1 else 0, "draws": 1000 if expected == 0.5 else 0, "losses": 1000 if expected == 0 else 0},
        "score": {"cp": 0 if outcome.winner is None else None, "mate": None if outcome.winner is None else (1 if outcome.winner else -1)},
        "depth": 0, "source": "exact-outcome",
    }


class AccuracyService(ExplainService):
    """Own engine and cancellation scope; cannot alter a live playing engine."""

    SEARCH_BUDGET = 3.0
    BEST_SECONDS = 0.45
    PLAYED_SECONDS = 0.40

    def __init__(self, engine_path):
        super().__init__(engine_path if callable(engine_path) else lambda: engine_path)

    def _search(self, engine, before, ident, token, seconds, *, root_move=None):
        if self._is_cancelled(ident, token):
            return None
        candidate = None
        try:
            with engine.analysis(before, chess.engine.Limit(time=seconds), multipv=1,
                                 root_moves=[root_move] if root_move else None) as analysis:
                with self._state_lock:
                    self._analysis = analysis
                    cancelled = ident in self._cancelled or token != self._latest_token
                if cancelled:
                    analysis.stop()
                for info in analysis:
                    reliable = _native_candidate(before, info, root_move)
                    if reliable is not None:
                        candidate = reliable
            return candidate
        finally:
            with self._state_lock:
                self._analysis = None

    def review(self, board: chess.Board, ident: str, ply: int) -> dict:
        if isinstance(ply, bool) or not isinstance(ply, int) or not 1 <= ply <= len(board.move_stack):
            raise AccuracyError("Choose a recorded move to score.")
        deadline = time.monotonic() + self.SEARCH_BUDGET
        after = board.copy()
        while len(after.move_stack) > ply:
            after.pop()
        before = after.copy()
        move = before.pop()
        result = {
            "requestId": ident, "initialFen": board.root().fen(),
            "moves": [item.uci() for item in board.move_stack], "ply": ply,
            "positionFen": after.fen(), "beforeFen": before.fen(), "afterFen": after.fen(),
            "move": {"uci": move.uci(), "san": before.san(move), "color": "white" if before.turn else "black"},
            "strength": 100, "forgiving": False, "skillLevel": 20,
            "methodVersion": METHOD_VERSION, "methodNote": METHOD_NOTE,
            "cancelled": False, "scored": False, "classification": None,
            "expectedPointsBefore": None, "expectedPointsAfter": None, "expectedPointsLoss": None,
            "moveAccuracy": None, "bestMove": None, "bestSan": None,
            "score": {"cp": None, "mate": None}, "depth": None,
            "engine": None, "unavailableReason": None,
        }
        with self._state_lock:
            if ident in self._cancelled:
                result["cancelled"] = True
                return result
            self._latest_token += 1
            token = self._latest_token
            previous = self._analysis
        if previous is not None:
            with suppress(chess.engine.EngineError, RuntimeError):
                previous.stop()
        while not self._work_lock.acquire(timeout=0.025):
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            if time.monotonic() >= deadline:
                raise AccuracyError("Accuracy analysis timed out. Retry the report.")
        timer = None
        try:
            with self._state_lock:
                self._active_id, self._active_token = ident, token
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            engine = self._get_engine()
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                raise TimeoutError("Accuracy budget exhausted during engine startup")
            timer = threading.Timer(remaining, self._expire, args=(engine, token))
            timer.daemon = True
            timer.start()
            required = {"Threads": 1, "Hash": 32, "Skill Level": 20, "UCI_LimitStrength": False, "UCI_ShowWDL": True}
            if not all(option in engine.options for option in required):
                raise AccuracyError("Accuracy reports need Stockfish with native WDL output and full-strength options.")
            engine.configure(required)
            if "Clear Hash" in engine.options:
                engine.configure({"Clear Hash": None})
            result["engine"] = engine.id.get("name", "Stockfish")
            best = self._search(engine, before, ident, token, min(self.BEST_SECONDS, max(0.01, remaining * 0.5)))
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            if best is not None:
                best = _terminal_candidate(before, best["move"]) or best
            played = _terminal_candidate(before, move)
            if played is None and best is not None and best["move"] == move:
                played = best
            if played is None:
                played = self._search(engine, before, ident, token,
                                      min(self.PLAYED_SECONDS, max(0.01, deadline - time.monotonic() - 0.05)), root_move=move)
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            # An immediate win is provably optimal. A sole legal move is also
            # optimal, provided its expected outcome was actually scored.
            if played is not None and (played["expected"] == 1 or before.legal_moves.count() == 1):
                best = played
            if best is None or played is None:
                result["unavailableReason"] = "Stockfish did not return reliable native win/draw/loss scores for both choices. Retry this move."
                return result
            # The played move is a legal candidate too: shallow search noise
            # must not produce negative loss or an inferior stated best move.
            if played["expected"] > best["expected"]:
                best = played
            result.update(_metrics(best["expected"], played["expected"]))
            result.update({
                "scored": True, "bestMove": best["move"].uci(), "bestSan": before.san(best["move"]),
                "score": played["score"], "depth": played["depth"], "bestDepth": best["depth"],
                "wdlBefore": best["wdl"], "wdlAfter": played["wdl"],
                "scoreSource": played["source"],
            })
            return result
        except (chess.engine.EngineError, OSError, TimeoutError, RuntimeError) as exc:
            self.close()
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            raise AccuracyError(f"Accuracy analysis is temporarily unavailable: {exc}. Retry the report.") from exc
        finally:
            if timer is not None:
                timer.cancel()
            with self._state_lock:
                self._analysis = None
                self._active_id = None
                self._active_token = None
            self._work_lock.release()
