"""Bounded additional opportunities for the local practice opponent."""

from __future__ import annotations

from dataclasses import dataclass

import chess
import chess.engine


MIN_LOSS_CP = 50
MAX_LOSS_CP = 150
MIN_SEARCH_DEPTH = 10


def _integer(value, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}.")
    return value


@dataclass(frozen=True)
class PracticePlan:
    target: int
    start_ply: int
    events: tuple
    ply: int

    @classmethod
    def from_request(cls, data: dict, board: chess.Board) -> "PracticePlan":
        practice = data.get("practice", {})
        if not isinstance(practice, dict):
            raise ValueError("practice must be an object.")
        ply = len(board.move_stack)
        target = _integer(practice.get("target", 0), "practice.target", 0, 2)
        start_ply = _integer(practice.get("startPly", 0), "practice.startPly", 0, ply)
        events = practice.get("events", [])
        if not isinstance(events, list) or len(events) > target:
            raise ValueError("practice.events must be an array no longer than the target.")
        committed = []
        previous = start_ply - 1
        for event in events:
            if not isinstance(event, dict):
                raise ValueError("Each practice event must be an object.")
            index = _integer(event.get("ply"), "practice event ply", start_ply, ply - 1)
            if index <= previous:
                raise ValueError("Practice events must be in strictly increasing ply order.")
            loss_cp = _integer(event.get("lossCp"), "practice event lossCp", MIN_LOSS_CP, MAX_LOSS_CP)
            move = event.get("move")
            if not isinstance(move, str) or move != board.move_stack[index].uci():
                raise ValueError("A practice event must match its committed move in the game history.")
            committed.append((index, move, loss_cp))
            previous = index
        return cls(target, start_ply, tuple(committed), ply)

    @property
    def used(self) -> int:
        return len(self.events)

    @property
    def eligible(self) -> bool:
        return (
            self.target > self.used
            and self.ply - self.start_ply >= 6
            and (not self.events or self.ply - self.events[-1][0] >= 12)
        )

    def choose(self, board: chess.Board, infos: list, baseline_move: chess.Move):
        """Return a copied engine info with practiceLossCp, or keep the baseline."""
        if not self.eligible or len(board.move_stack) != self.ply or board.is_game_over(claim_draw=False):
            return None
        legal_moves = set(board.legal_moves)
        if baseline_move not in legal_moves:
            return None

        # Never add a deliberate error when an immediate mate is available.
        replay = board.copy(stack=False)
        for move in legal_moves:
            replay.push(move)
            immediate_mate = replay.is_checkmate()
            replay.pop()
            if immediate_mate:
                return None

        candidates = {}
        top_cp = None
        for index, info in enumerate(infos):
            if not isinstance(info, dict):
                continue
            pv = info.get("pv", [])
            if not pv or pv[0] not in legal_moves:
                continue
            score = info.get("score")
            if not isinstance(score, chess.engine.PovScore):
                continue
            mover_score = score.pov(board.turn)
            if mover_score.is_mate():
                return None
            cp = mover_score.score()
            depth = info.get("depth", 0)
            if (
                isinstance(cp, bool) or not isinstance(cp, int)
                or isinstance(depth, bool) or not isinstance(depth, int) or depth < MIN_SEARCH_DEPTH
                or info.get("lowerbound") or info.get("upperbound")
            ):
                continue
            if index == 0:
                top_cp = cp
            prior = candidates.get(pv[0])
            if prior is None or depth > prior[1].get("depth", 0):
                candidates[pv[0]] = (cp, info)

        if top_cp is None or baseline_move not in candidates:
            return None
        best_cp = top_cp
        if any(cp > best_cp for cp, _ in candidates.values()):
            return None
        baseline_cp = candidates[baseline_move][0]
        if best_cp - baseline_cp > 25:
            return None
        eligible = []
        for move, (cp, info) in candidates.items():
            loss_cp = best_cp - cp
            if move != baseline_move and MIN_LOSS_CP <= loss_cp <= MAX_LOSS_CP and baseline_cp - cp >= MIN_LOSS_CP:
                eligible.append((loss_cp, move.uci(), info))
        if not eligible:
            return None
        loss_cp, _, chosen = min(eligible, key=lambda item: (item[0], item[1]))
        return {**chosen, "practiceLossCp": loss_cp}

    def payload(self, chosen=None) -> dict:
        result = {
            "target": self.target,
            "used": self.used,
            "deliberate": False,
            "lossCp": None,
            "event": None,
        }
        if chosen is not None:
            loss_cp = chosen["practiceLossCp"]
            result.update({
                "deliberate": True,
                "lossCp": loss_cp,
                "event": {"ply": self.ply, "move": chosen["pv"][0].uci(), "lossCp": loss_cp},
            })
        return result
