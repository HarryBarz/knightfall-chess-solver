"""Choose real practice moves toward a local accuracy band, without altering review.

Candidate quality uses the same public numeric curve as accuracy.py. Feedback
uses committed moves only; its forecast is not the independent after-game score.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import statistics

import chess
import chess.engine

from accuracy import _move_accuracy, _win_percent, _terminal_candidate


LOWER, UPPER = 85, 90
MIDPOINT = (LOWER + UPPER) / 2
MIN_DEPTH = 8
MIN_MOVE_ACCURACY = 75
MAX_LOSS_CP = 200
SEARCH_LINES = 24


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer between {low} and {high}.")
    return value


def _percent(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 100


def estimate(events, start_ply, color):
    """V2-style prefix forecast from searched before/after positions.

    A recorded before-position also evaluates the preceding opponent move.
    Unknown positions keep their places and receive the same minimum window
    weight as provisional browser reports. No accuracy is invented for them.
    """
    if not events:
        return None
    count = events[-1]["ply"] + 1 - start_ply
    probabilities = [None] * (count + 1)
    for event in events:
        index = event["ply"] - start_ply
        probabilities[index] = event["before"] if color else 100 - event["before"]
        probabilities[index + 1] = event["after"] if color else 100 - event["after"]
    width = max(2, min(8, count // 10))
    weighted_sum = weight_sum = reciprocal_sum = 0.0
    for event in events:
        index = event["ply"] - start_ply
        begin = max(0, index - width + 2)
        window = probabilities[begin:begin + width]
        weight = max(.5, min(12, statistics.pstdev(window))) if len(window) == width and all(value is not None for value in window) else .5
        weighted_sum += event["accuracy"] * weight
        weight_sum += weight
        reciprocal_sum += 1 / max(1, event["accuracy"])
    return min(100.0, max(0.0, (weighted_sum / weight_sum + len(events) / reciprocal_sum) / 2))


@dataclass(frozen=True)
class AccuracyTarget:
    enabled: bool
    start_ply: int
    events: tuple
    ply: int
    color: chess.Color

    @classmethod
    def from_request(cls, data, board):
        request = data.get("accuracyTarget", {})
        if not isinstance(request, dict) or not isinstance(request.get("enabled", False), bool):
            raise ValueError("accuracyTarget must be an object with a boolean enabled setting.")
        enabled = request.get("enabled", False)
        ply = len(board.move_stack)
        start = _integer(request.get("startPly", 0), "accuracyTarget.startPly", 0, ply)
        events = request.get("events", [])
        if not isinstance(events, list) or len(events) > (ply - start + 1) // 2:
            raise ValueError("Accuracy target events must fit the recorded game history.")
        checked, prior = [], start - 1
        for event in events:
            if not isinstance(event, dict):
                raise ValueError("Each accuracy target event must be an object.")
            index = _integer(event.get("ply"), "accuracy target event ply", start, ply - 1)
            if index <= prior or (ply - index) % 2 or event.get("move") != board.move_stack[index].uci():
                raise ValueError("Accuracy target events must match committed moves by this side, in order.")
            before, after, accuracy = (event.get(key) for key in ("before", "after", "accuracy"))
            if not all(_percent(value) for value in (before, after, accuracy)) or after > before:
                raise ValueError("Accuracy target event percentages must be finite, bounded, and mover-relative.")
            if abs(accuracy - _move_accuracy(before, after)) > .000001:
                raise ValueError("Accuracy target event score does not match its recorded evaluations.")
            checked.append({"ply": index, "move": event["move"], "before": before, "after": after, "accuracy": accuracy})
            prior = index
        return cls(enabled, start, tuple(checked), ply, board.turn)

    def payload(self, event=None, reason=None):
        events = self.events + ((event,) if event else ())
        return {"enabled": self.enabled, "lower": LOWER, "upper": UPPER,
                "estimatedAccuracy": estimate(events, self.start_ply, self.color),
                "event": event, "reason": reason}

    def choose(self, board, infos, baseline_move):
        if not self.enabled or len(board.move_stack) != self.ply or board.turn != self.color or board.is_game_over(claim_draw=False):
            return None, self.payload()
        legal = set(board.legal_moves)
        candidates = []
        for index, info in enumerate(infos):
            pv, score = info.get("pv", []), info.get("score")
            if not pv or pv[0] not in legal or not isinstance(score, chess.engine.PovScore):
                continue
            if info.get("lowerbound") or info.get("upperbound") or info.get("depth", 0) < MIN_DEPTH:
                continue
            white = score.white()
            terminal = _terminal_candidate(board, pv[0])
            value = terminal["score"] if terminal else {"cp": white.score(), "mate": white.mate()}
            if value["cp"] is None and value["mate"] is None:
                continue
            cp = value["cp"] * (1 if board.turn else -1) if value["cp"] is not None else None
            candidates.append({"info": info, "move": pv[0], "score": value, "cp": cp,
                               "percent": _win_percent(value, board.turn), "index": index})
        reference = next((item for item in candidates if item["index"] == 0), None)
        if reference is None:
            return None, self.payload(reason="insufficient-analysis")

        # Preserve forced replies and mating lines. The target cannot require
        # throwing away a win or choosing an earlier forced loss to lower a score.
        immediate = next((item for item in candidates if (terminal := _terminal_candidate(board, item["move"]))
                          and terminal["expected"] == 1), None)
        reason = None
        if immediate:
            chosen, reason = immediate, "immediate-mate"
        elif len(legal) == 1:
            chosen, reason = reference, "forced-move"
        elif reference["score"]["mate"] is not None:
            chosen, reason = reference, "mate-line"
        else:
            # Finite score comparisons also protect against stale/inconsistent
            # MultiPV rankings; an unreliable reference must not create an error.
            if any(item["cp"] is not None and item["cp"] > reference["cp"] for item in candidates):
                return None, self.payload(reason="inconsistent-analysis")
            available = []
            for item in candidates:
                if item["cp"] is None or not 0 <= reference["cp"] - item["cp"] <= MAX_LOSS_CP:
                    continue
                event = self._event(item, reference)
                if event["accuracy"] >= MIN_MOVE_ACCURACY:
                    available.append((item, event))
            if not any(event["accuracy"] <= 95 for _, event in available):
                chosen, reason = reference, "no-suitable-alternative"
            else:
                # Feedback is bounded by both a move-accuracy floor and a pawn
                # loss ceiling: a long forced sequence cannot demand a blunder.
                chosen, _ = min(available, key=lambda pair: (
                    abs(estimate(self.events + (pair[1],), self.start_ply, self.color) - MIDPOINT),
                    -pair[0]["cp"], pair[0]["move"].uci()))
                reason = "target-choice"
        event = self._event(chosen, reference)
        return chosen["info"], self.payload(event, reason)

    def _event(self, chosen, reference):
        before, after = max(reference["percent"], chosen["percent"]), chosen["percent"]
        return {"ply": self.ply, "move": chosen["move"].uci(), "before": before, "after": after,
                "accuracy": _move_accuracy(before, after)}
