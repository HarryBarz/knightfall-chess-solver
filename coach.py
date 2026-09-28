"""Bounded, independent move review with board-grounded explanations."""

from __future__ import annotations

from collections import OrderedDict
from contextlib import suppress
import threading
import time

import chess
import chess.engine


class CoachError(Exception):
    pass


def move_reasons(before: chess.Board, move: chess.Move) -> list[str]:
    """Describe observable effects; geometry alone never proves a winning tactic."""
    piece = before.piece_at(move.from_square)
    after = before.copy(stack=False)
    after.push(move)
    side = "White" if piece.color else "Black"
    opponent = "Black" if piece.color else "White"
    name = chess.piece_name(piece.piece_type)
    destination = chess.square_name(move.to_square)
    reasons = []
    if after.is_checkmate():
        reasons.append(f"It checkmates {opponent}: the king is in check and there is no legal reply.")
    elif after.is_check():
        king = chess.square_name(after.king(not piece.color))
        reasons.append(f"It checks {opponent}'s king on {king}, so the next move must answer the check.")
    if before.is_castling(move):
        rook_from, rook_to = ("h", "f") if before.is_kingside_castling(move) else ("a", "d")
        rank = "1" if piece.color else "8"
        reasons.append(f"Castling moves the king to {destination} and brings the rook from {rook_from}{rank} to {rook_to}{rank}.")
    if before.is_capture(move):
        captured = before.piece_at(move.to_square)
        if before.is_en_passant(move):
            square = chess.square(chess.square_file(move.to_square), chess.square_rank(move.from_square))
            reasons.append(f"It captures the pawn on {chess.square_name(square)} en passant.")
        elif captured:
            reasons.append(f"It captures {opponent}'s {chess.piece_name(captured.piece_type)} on {destination}.")
    if move.promotion:
        reasons.append(f"The pawn promotes to a {chess.piece_name(move.promotion)} on {destination}.")
    if piece.piece_type in (chess.KNIGHT, chess.BISHOP):
        home_rank = 0 if piece.color else 7
        if chess.square_rank(move.from_square) == home_rank and chess.square_rank(move.to_square) != home_rank:
            reasons.append(f"It develops the {name} from {chess.square_name(move.from_square)} away from {side}'s back rank.")
    attacks = after.attacks(move.to_square)
    pinned = after.is_pinned(piece.color, move.to_square)
    moved_name = chess.piece_name(move.promotion or piece.piece_type)
    if pinned:
        reasons.append(f"The {moved_name} on {destination} is pinned to {side}'s king, which limits its legal moves.")
    targets = sorted(
        ((square, after.piece_at(square)) for square in attacks
         if after.piece_at(square) and after.piece_at(square).color != piece.color),
        key=lambda item: (-item[1].piece_type, item[0]),
    )
    targets = [(square, target) for square, target in targets if target.piece_type != chess.KING]
    if targets:
        listed = [f"the {chess.piece_name(target.piece_type)} on {chess.square_name(square)}" for square, target in targets[:3]]
        joined = ", ".join(listed[:-1]) + " and " + listed[-1] if len(listed) > 1 else listed[0]
        action = "geometrically attacks" if pinned else "attacks"
        qualification = (
            "The pin restricts legal captures; an attacked piece is not automatically available to take."
            if pinned else "The opponent can respond; these attacks do not establish a forced material win."
        )
        reasons.append(f"From {destination}, the {moved_name} {action} {joined}. {qualification}")
    center = {chess.D4, chess.E4, chess.D5, chess.E5}
    if move.to_square in center:
        reasons.append(f"It places the {name} in the center on {destination}.")
    central_attacks = sorted(center.intersection(attacks))
    if central_attacks:
        squares = ", ".join(chess.square_name(square) for square in central_attacks)
        action = "geometrically attacks" if pinned else "attacks"
        reasons.append(f"From {destination}, it {action} the central square{'s' if len(central_attacks) != 1 else ''} {squares}.")
    if piece.piece_type == chess.PAWN:
        for square, ally in before.piece_map().items():
            if ally.color == piece.color and ally.piece_type == chess.BISHOP:
                opened = set(after.attacks(square)) - set(before.attacks(square))
                if opened:
                    reasons.append(f"Moving this pawn opens a diagonal for the bishop on {chess.square_name(square)}.")
                    break
    if not reasons:
        reasons.append(f"It moves {side}'s {name} from {chess.square_name(move.from_square)} to {destination}, changing the squares it covers.")
    return reasons


def _line(before: chess.Board, info: dict) -> dict | None:
    replay = before.copy(stack=False)
    sans, ucis = [], []
    for move in info.get("pv", [])[:12]:
        if move not in replay.legal_moves:
            break
        sans.append(replay.san(move))
        ucis.append(move.uci())
        replay.push(move)
    if not ucis:
        return None
    score = info.get("score")
    white = score.white() if score is not None else None
    return {
        "move": ucis[0], "san": sans[0], "pv": sans, "uciPv": ucis,
        "score": {"cp": white.score() if white is not None else None, "mate": white.mate() if white is not None else None},
    }


def _rank(line: dict, color: chess.Color) -> int:
    score = line["score"]
    if score["mate"] is not None:
        mate = score["mate"]
        value = 100_000 - mate if mate > 0 else -100_000 - mate
    elif score["cp"] is not None:
        value = score["cp"]
    else:
        return -1_000_000
    return value if color else -value


class ExplainService:
    SEARCH_BUDGET = 1.8

    def __init__(self, engine_path):
        self._engine_path = engine_path
        self._engine = None
        self._work_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._analysis = None
        self._active_id = None
        self._active_token = None
        self._latest_token = 0
        self._cancelled = OrderedDict()

    def _is_cancelled(self, ident, token):
        with self._state_lock:
            return ident in self._cancelled or token != self._latest_token

    def stop(self, ident: str) -> dict:
        with self._state_lock:
            self._cancelled[ident] = True
            self._cancelled.move_to_end(ident)
            while len(self._cancelled) > 2048:
                self._cancelled.popitem(last=False)
            active = self._active_id == ident
            analysis = self._analysis if active else None
        if analysis is not None:
            with suppress(chess.engine.EngineError, RuntimeError):
                analysis.stop()
        return {"ok": True, "requestId": ident, "stopped": active}

    def _get_engine(self):
        if self._engine is None:
            path = self._engine_path()
            if path is None:
                raise CoachError("Move review needs Stockfish. Check the engine installation.")
            self._engine = chess.engine.SimpleEngine.popen_uci(path, timeout=0.65)
        return self._engine

    def _expire(self, engine, token):
        with self._state_lock:
            if self._active_token != token or self._engine is not engine:
                return
            self._engine = None
            engine.close()

    def _search(self, engine, before, ident, token, seconds, *, root_moves=None):
        if self._is_cancelled(ident, token):
            return []
        with engine.analysis(before, chess.engine.Limit(time=seconds), multipv=4 if root_moves is None else 1, root_moves=root_moves) as analysis:
            with self._state_lock:
                self._analysis = analysis
                cancelled = ident in self._cancelled or token != self._latest_token
            if cancelled:
                analysis.stop()
            analysis.wait()
            infos = analysis.multipv
        with self._state_lock:
            self._analysis = None
        return infos

    def explain(self, board: chess.Board, ident: str, strength: int, forgiving: bool) -> dict:
        started = time.monotonic()
        deadline = started + self.SEARCH_BUDGET
        skill = (strength - 10) * 20 // 90
        if forgiving:
            skill = min(skill, 4)
        result = {
            "requestId": ident, "positionFen": board.fen(), "initialFen": board.root().fen(),
            "moves": [move.uci() for move in board.move_stack], "ply": len(board.move_stack),
            "move": None, "beforeFen": board.fen(), "afterFen": board.fen(),
            "strength": strength, "forgiving": forgiving, "skillLevel": skill,
            "summary": "Play a move to begin.", "reasons": [], "alternatives": [],
            "played": None, "assessment": "", "cancelled": False,
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
        if not board.move_stack or self._is_cancelled(ident, token):
            result["cancelled"] = self._is_cancelled(ident, token)
            return result
        before = board.copy()
        move = before.pop()
        piece = before.piece_at(move.from_square)
        san = before.san(move)
        result.update({
            "beforeFen": before.fen(),
            "move": {
                "uci": move.uci(), "san": san, "color": "white" if piece.color else "black",
                "from": chess.square_name(move.from_square), "to": chess.square_name(move.to_square),
                "piece": chess.piece_name(piece.piece_type),
            },
            "summary": f"{'White' if piece.color else 'Black'} played {san}.",
            "reasons": move_reasons(before, move),
        })
        while not self._work_lock.acquire(timeout=0.025):
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            if time.monotonic() >= deadline:
                raise CoachError("Move review timed out. Try reviewing this move again.")
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
                raise TimeoutError("Review budget exhausted during engine startup")
            timer = threading.Timer(remaining, self._expire, args=(engine, token))
            timer.daemon = True
            timer.start()
            options = {"Threads": 1, "Hash": 32}
            if "UCI_LimitStrength" in engine.options:
                options["UCI_LimitStrength"] = False
            if "Skill Level" in engine.options:
                options["Skill Level"] = skill
            elif skill < 20:
                raise CoachError("This engine does not support review at reduced practice strength. Use Stockfish.")
            engine.configure(options)
            infos = self._search(engine, before, ident, token, min(0.45, max(0.01, (deadline - time.monotonic()) * 0.55)))
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            lines = [line for info in infos if (line := _line(before, info))]
            played = next((line for line in lines if line["move"] == move.uci()), None)
            if played is None:
                actual_infos = self._search(engine, before, ident, token, min(0.30, max(0.01, deadline - time.monotonic() - 0.05)), root_moves=[move])
                played = next((line for info in actual_infos if (line := _line(before, info)) and line["move"] == move.uci()), None)
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            if played is None:
                raise CoachError("Stockfish did not return a score for the played move. Try reviewing it again.")
            if not any(line["move"] == played["move"] for line in lines):
                lines.append(played)
            lines.sort(key=lambda line: _rank(line, before.turn), reverse=True)
            result["played"] = played
            for line in lines:
                if line["move"] != move.uci():
                    line["reason"] = " ".join(move_reasons(before, chess.Move.from_uci(line["move"]))[:2])
                    result["alternatives"].append(line)
                if len(result["alternatives"]) == 3:
                    break
            result["assessment"] = self._assessment(board, lines, played, strength, forgiving)
            return result
        except (chess.engine.EngineError, OSError, TimeoutError, RuntimeError) as exc:
            self.close()
            if self._is_cancelled(ident, token):
                result["cancelled"] = True
                return result
            raise CoachError(f"Move review is temporarily unavailable: {exc}. Your game can continue.") from exc
        finally:
            if timer is not None:
                timer.cancel()
            with self._state_lock:
                self._analysis = None
                self._active_id = None
                self._active_token = None
            self._work_lock.release()

    @staticmethod
    def _assessment(board, lines, played, strength, forgiving):
        label = f"the selected {strength}% strength" + (" with forgiving practice" if forgiving else "")
        if board.is_checkmate():
            return f"This move ends the game with checkmate. The review used {label}."
        outcome = board.outcome(claim_draw=False)
        if outcome is not None:
            reason = outcome.termination.name.lower().replace("_", " ")
            return f"This move ends the game in a draw by {reason}. The review used {label}."
        if not lines:
            return f"The played move was evaluated at {label}. This brief search is an estimate."
        leader = lines[0]
        qualification = (
            "Reduced strength can choose a different move from the highest-scoring candidate."
            if strength < 100 or forgiving else "A longer search can change these estimates."
        )
        if leader["move"] == played["move"]:
            return f"In this short review at {label}, this move had the highest evaluation among the reviewed candidates. {qualification}"
        text = f"In this short review at {label}, {leader['san']} had the highest evaluation among the reviewed candidates."
        leading_score, played_score = leader["score"], played["score"]
        if leading_score["cp"] is not None and played_score["cp"] is not None:
            mover = not board.turn
            gap = (leading_score["cp"] - played_score["cp"]) * (1 if mover else -1)
            if gap >= 50:
                text += f" It scored the played move about {gap / 100:.1f} pawns lower for {'White' if mover else 'Black'}."
            else:
                text += " The scores were close in this brief review."
        elif leading_score["mate"] is not None:
            text += " The leading line contains a mate score; compare its continuation with the played move."
        return text + " " + qualification

    def close(self):
        with self._state_lock:
            engine, self._engine = self._engine, None
        if engine is not None:
            with suppress(Exception):
                engine.close()
