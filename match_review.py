"""Post-game lessons built from legal moves and independent Stockfish searches.

The explanations describe observable ideas and conditional continuations. They
never claim to know a player's intention, or convert an engine score to accuracy.
"""

from __future__ import annotations

import chess

from coach import ExplainService, move_reasons


LOOKAHEAD_CHOICES = (2, 3, 4, 6, 8)


class _ReviewEngine(ExplainService):
    SEARCH_BUDGET = 4.0

    def _search(self, engine, before, ident, token, seconds, *, root_moves=None):
        # A separate engine and a longer bounded search leave live play alone.
        # A fresh root avoids a transposition-table score with a one-move PV:
        # this service needs an explanatory continuation, not just evaluation.
        if "Clear Hash" in engine.options:
            engine.configure({"Clear Hash": None})
        return super()._search(
            engine, before, ident, token, min(seconds * 2, 1.0), root_moves=root_moves,
        )

    def stopped(self, ident):
        with self._state_lock:
            return ident in self._cancelled


def _side(color):
    return "White" if color else "Black"


def _facts(before: chess.Board, move: chess.Move) -> list[str]:
    """Extend the live coach's immediate facts with support and move connections."""
    facts = move_reasons(before, move)
    piece = before.piece_at(move.from_square)
    after = before.copy(stack=False)
    after.push(move)
    if after.is_checkmate():
        # The live coach also lists geometrical attacks, whose generic wording
        # assumes an opponent can respond. There are no replies after mate.
        return [facts[0]]
    destination = chess.square_name(move.to_square)
    moved_name = chess.piece_name(move.promotion or piece.piece_type)
    if before.is_check():
        facts.append("The king was in check before this move; this legal reply gets it out of check.")
    if len(before.move_stack) >= 2:
        previous_turn = before.move_stack[-2]
        if previous_turn.to_square == move.from_square:
            facts.append(f"This continues the same {chess.piece_name(piece.piece_type)}'s maneuver from {chess.square_name(previous_turn.from_square)} through {chess.square_name(move.from_square)} to {destination}.")
    if before.move_stack and before.is_capture(move):
        previous = before.peek()
        previous_position = before.copy()
        previous_position.pop()
        if previous.to_square == move.to_square and previous_position.is_capture(previous):
            facts.append(f"This is a recapture on {destination}, continuing the exchange started by the previous move.")
    if not after.is_pinned(piece.color, move.to_square):
        previous_attacks = set(before.attacks(move.from_square))
        supported = [
            square for square in sorted(after.attacks(move.to_square))
            if square not in previous_attacks
            and (ally := after.piece_at(square))
            and ally.color == piece.color and ally.piece_type != chess.KING
        ]
        if supported:
            names = [f"the {chess.piece_name(after.piece_at(square).piece_type)} on {chess.square_name(square)}" for square in supported[:2]]
            facts.append(f"From {destination}, the {moved_name} now defends " + " and ".join(names) + ". A defender can still be exchanged or deflected.")
    if piece.piece_type == chess.PAWN and not move.promotion:
        rank = chess.square_rank(move.to_square)
        file = chess.square_file(move.to_square)
        opposing_pawns_ahead = [
            square for square in after.pieces(chess.PAWN, not piece.color)
            if abs(chess.square_file(square) - file) <= 1
            and (chess.square_rank(square) > rank if piece.color else chess.square_rank(square) < rank)
        ]
        if not opposing_pawns_ahead:
            facts.append(f"The pawn on {destination} is a passed pawn: no opposing pawn remains ahead of it on its file or the neighboring files. Other pieces can still stop it.")
    return facts


def _steps(start: chess.Board, ucis: list[str], limit: int, *, projected: bool) -> list[dict]:
    board = start.copy()
    steps = []
    for uci in ucis[:limit]:
        if board.is_game_over(claim_draw=False):
            break
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in board.legal_moves:
            break
        before_fen = board.fen()
        side = _side(board.turn)
        san = board.san(move)
        facts = _facts(board, move)
        connections = [fact for fact in facts if "king was in check" in fact or "recapture" in fact or "continues the same" in fact]
        board.push(move)
        verb = "could play" if projected else "played"
        steps.append({
            "ply": len(steps) + 1, "move": uci, "san": san,
            "color": "white" if not board.turn else "black",
            "beforeFen": before_fen, "fen": board.fen(), "reasons": facts,
            "summary": f"{side} {verb} {san}. " + " ".join(dict.fromkeys([*facts[:2], *connections])),
        })
    for index, step in enumerate(steps[:-1]):
        next_step = steps[index + 1]
        next_board = chess.Board(next_step["beforeFen"])
        move = chess.Move.from_uci(step["move"])
        reply = chess.Move.from_uci(next_step["move"])
        if next_board.is_capture(reply) and reply.to_square == move.to_square:
            mode = "In this projected line" if projected else "In the game"
            connection = f"{mode}, {next_step['san']} then captures the piece that just moved to {chess.square_name(move.to_square)}. Follow the exchange before judging the material balance."
            step["reasons"].append(connection)
            step["summary"] += " " + connection
    return steps


def _score_value(line: dict, color: chess.Color) -> float | None:
    """Order White-perspective scores from the mover's point of view."""
    score = line.get("score") or {}
    mate, cp = score.get("mate"), score.get("cp")
    if mate is not None:
        # A legal pre-move search normally reports mate >= 1 in magnitude.
        # Mate(0) has lost its sign in JSON and cannot be safely ranked here.
        if mate == 0:
            return None
        white_value = 100_000 - mate if mate > 0 else -100_000 - mate
    elif cp is not None:
        white_value = cp
    else:
        return None
    return white_value if color else -white_value


def _best_line(lines: list[dict], color: chess.Color) -> dict:
    return max(lines, key=lambda line: _score_value(line, color) if _score_value(line, color) is not None else -float("inf"))


def _mate_for(line: dict, color: chess.Color) -> int | None:
    mate = line.get("score", {}).get("mate")
    return mate * (1 if color else -1) if mate is not None else None


def _verdict(after: chess.Board, played: dict, best: dict) -> dict:
    mover = not after.turn
    side = _side(mover)
    played_cp, best_cp = played["score"].get("cp"), best["score"].get("cp")
    loss = max(0, (best_cp - played_cp) * (1 if mover else -1)) if played_cp is not None and best_cp is not None else None
    if after.is_checkmate():
        return {"label": "Checkmate", "detail": f"{side} ends the game: the opposing king is in check with no legal answer.", "lossCp": None}
    outcome = after.outcome(claim_draw=False)
    if outcome is not None:
        reason = outcome.termination.name.lower().replace("_", " ")
        detail = f"The game ends in a draw by {reason}."
        if best["move"] != played["move"] and (loss is not None and loss >= 50 or (_mate_for(best, mover) or 0) > 0):
            detail += f" The search preferred {best['san']}; compare that line to see the opportunity before the draw."
        return {"label": "Draw", "detail": detail, "lossCp": loss}
    if best["move"] == played["move"]:
        return {"label": "Best reviewed move", "detail": f"This move had the best score for {side} among the searched candidates. That credits this move, even when the overall position is difficult.", "lossCp": loss}
    best_mate, played_mate = _mate_for(best, mover), _mate_for(played, mover)
    if best_mate is not None or played_mate is not None:
        if best_mate is not None and best_mate > 0:
            label = "Faster mating line" if played_mate is not None and played_mate > 0 else "Missed mating line"
            detail = f"Stockfish found a mating continuation beginning with {best['san']}."
            if played_mate is not None and played_mate > 0:
                detail += " The played move also received a winning mate score; the alternative's mate estimate is shorter."
            else:
                detail += " The played move did not receive a winning mate score in this search."
        elif played_mate is not None and played_mate < 0:
            if best_mate is not None and best_mate < 0:
                label = "Under mating pressure"
                detail = f"Both moves received losing mate scores for {side}; {best['san']} delays the searched mate. No saving move was established by these candidates."
            else:
                label = "Allows a mating line"
                detail = f"The played line received a losing mate score for {side}; {best['san']} did not in this search."
        else:
            label, detail = "Compare the mating lines", f"Compare {best['san']} with the played move; a mate score cannot be treated as a pawn difference."
        return {"label": label, "detail": detail + " Mate estimates come from the search, and the visible preview may end before mate.", "lossCp": None}
    if loss is None:
        return {"label": "Unscored comparison", "detail": "There is not enough scoring information to grade this move reliably.", "lossCp": None}
    if loss <= 30:
        label = "Close alternative"
        detail = f"The score is close to {best['san']}, the leading searched move. This is not a clear mistake in this brief review."
    else:
        label = "Inaccuracy" if loss < 100 else "Mistake" if loss < 250 else "Blunder"
        detail = f"Compared with {best['san']}, the played move scores about {loss / 100:.1f} pawns lower for {side}. This is an evaluation difference, not a count of pieces lost."
    return {"label": label, "detail": detail, "lossCp": loss}


def _plan(before: chess.Board, move: chess.Move, facts: list[str], continuation: list[dict]) -> str:
    side = _side(before.turn)
    sentences = [f"A board-based reading of {side}'s {before.san(move)}: " + " ".join(facts[:3])]
    if continuation:
        reply = continuation[0]
        sentences.append(f"A possible response is {reply['san']}. " + reply["reasons"][0])
        same_side = [step for step in continuation if step["color"] == ("white" if before.turn else "black")]
        if same_side:
            followup = same_side[0]
            sentences.append(f"If the opponent follows this line, {side} can then play {followup['san']}. " + followup["reasons"][0])
        if len(same_side) > 1:
            later = same_side[-1]
            sentences.append(f"Further along this branch, {later['san']} is the next idea to inspect. " + later["reasons"][0])
        turn_word = "turn" if len(continuation) == 1 else "turns"
        sentences.append(f"The preview shows {len(continuation)} future {turn_word}: each step is one player's move, so two steps are one move by each side.")
    else:
        after = before.copy()
        after.push(move)
        if after.is_game_over(claim_draw=False):
            sentences.append("The game ends here, so there is no legal continuation to study.")
        else:
            sentences.append("The bounded search did not supply a longer legal continuation for this move.")
    sentences.append("These are plausible ideas supported by the board and search, not a claim about what either player was thinking. Projected replies are conditional; a different reply changes the plan.")
    return " ".join(sentences)


def _capture_contrast(before: chess.Board, move: chess.Move, alternative: chess.Move, continuation: list[dict]) -> str:
    """Explain an immediate capture by comparing factual piece locations."""
    if not continuation:
        return ""
    after = before.copy()
    after.push(move)
    reply = chess.Move.from_uci(continuation[0]["move"])
    if reply not in after.legal_moves or not after.is_capture(reply):
        return ""
    captured_square = (
        chess.square(chess.square_file(reply.to_square), chess.square_rank(reply.from_square))
        if after.is_en_passant(reply) else reply.to_square
    )
    captured = after.piece_at(captured_square)
    if captured_square != move.to_square or captured is None:
        return ""
    text = f"In the played continuation, {_side(after.turn)} can answer {before.san(move)} with {after.san(reply)}, capturing the {chess.piece_name(captured.piece_type)} on {chess.square_name(captured_square)}."
    alternate_board = before.copy()
    alternate_board.push(alternative)
    original = before.piece_at(move.from_square)
    if alternative.from_square == move.from_square:
        placed = alternate_board.piece_at(alternative.to_square)
        text += f" With {before.san(alternative)} instead, the {chess.piece_name(placed.piece_type)} goes to {chess.square_name(alternative.to_square)}."
    elif alternate_board.piece_at(move.from_square) == original:
        text += f" With {before.san(alternative)} instead, the {chess.piece_name(original.piece_type)} stays on {chess.square_name(move.from_square)}."
    return text


def _check_contrast(before: chess.Board, move: chess.Move, alternative: chess.Move, continuation: list[dict]) -> str:
    """Compare legal answers to a checking reply, without promising a saved game."""
    if not continuation:
        return ""
    played = before.copy()
    played.push(move)
    reply = chess.Move.from_uci(continuation[0]["move"])
    if reply not in played.legal_moves or not played.gives_check(reply):
        return ""
    checking_san = played.san(reply)
    alternate = before.copy()
    alternate.push(alternative)
    alternative_san = before.san(alternative)
    if reply not in alternate.legal_moves:
        return f"The played line allows {checking_san}. After {alternative_san}, that same reply is not legal in the changed position."
    alternate.push(reply)
    if not alternate.is_check():
        return f"The played line allows {checking_san}. After {alternative_san}, the same reply no longer gives check."
    answers = [alternate.san(answer) for answer in list(alternate.legal_moves)[:3]]
    if not answers:
        return ""
    return (f"The played line allows {checking_san}. After {alternative_san}, the same checking move can be answered legally with "
            + ", ".join(answers) + ". These moves answer the immediate check; the continuation is needed to assess the resulting position.")


class MatchReviewService:
    def __init__(self, engine_path):
        self._reviewer = _ReviewEngine(engine_path)

    def stop(self, ident: str) -> dict:
        return self._reviewer.stop(ident)

    def close(self):
        self._reviewer.close()

    def review(self, board: chess.Board, ident: str, ply: int, lookahead: int, strength: int, forgiving: bool) -> dict:
        if type(ply) is not int or not 1 <= ply <= len(board.move_stack):
            raise ValueError("Choose a move from this game's recorded history.")
        if type(lookahead) is not int or lookahead not in LOOKAHEAD_CHOICES:
            raise ValueError("Lookahead must be 2, 3, 4, 6, or 8 half-moves.")
        if type(strength) is not int or not 10 <= strength <= 100 or type(forgiving) is not bool:
            raise ValueError("Review strength must be an integer from 10 to 100 and forgiving must be a boolean.")
        if not isinstance(ident, str) or not ident or len(ident) > 128:
            raise ValueError("A review request needs a valid request ID.")
        original = board.copy()
        full_moves = [move.uci() for move in original.move_stack]
        after = original.copy()
        while len(after.move_stack) > ply:
            after.pop()
        before = after.copy()
        move = before.pop()
        result = self._reviewer.explain(after, ident, strength, forgiving)
        result.update({
            "moves": full_moves, "ply": ply, "lookahead": lookahead,
            "plan": "", "verdict": None, "continuation": [], "actualContinuation": [], "correction": None,
            "scorePerspective": "white",
            "analysisNote": "This is a bounded Stockfish review at the selected strength. A longer search or a different reply can change the evaluation; strength is not an accuracy percentage.",
            "continuationNote": "Projected continuation after the played move. Each step is one half-move by one player, and the line may end early at a terminal position or when the engine preview ends.",
        })
        if result["cancelled"]:
            return result
        facts = _facts(before, move)
        played = result["played"]
        candidates = [played, *result["alternatives"]]
        best = _best_line(candidates, before.turn)
        verdict = _verdict(after, played, best)
        continuation = _steps(after, played.get("uciPv", [])[1:], lookahead, projected=True)
        if len(continuation) < lookahead:
            count = len(continuation)
            result["continuationNote"] = (
                f"This preview is shorter than the selected {lookahead}-turn horizon: "
                f"the engine supplied {count} legal future {'turn' if count == 1 else 'turns'}. "
                "A line can finish at game end or when the bounded search has no further moves to show."
            )
        actual = _steps(after, full_moves[ply:], lookahead, projected=False)
        correction = None
        # Close scores do not justify presenting a correction as necessary.
        if best["move"] != played["move"] and verdict["label"] not in {"Checkmate", "Close alternative", "Unscored comparison"}:
            alternative = chess.Move.from_uci(best["move"])
            if alternative in before.legal_moves:
                contrast = " ".join(part for part in (
                    _capture_contrast(before, move, alternative, continuation),
                    _check_contrast(before, move, alternative, continuation),
                ) if part)
                correction = {
                    "move": best["move"], "san": best["san"], "score": dict(best["score"]),
                    "explanation": " ".join(part for part in [verdict["detail"], contrast, " ".join(_facts(before, alternative)[:3])] if part) + " Replay this alternative to compare the resulting positions; it is a searched possibility, not a prediction of the opponent's choice.",
                    "continuation": _steps(before, best.get("uciPv", []), lookahead + 1, projected=True),
                }
        result.update({
            "summary": f"{_side(before.turn)} played {before.san(move)}. {verdict['label']}.",
            "reasons": facts, "verdict": verdict,
            "plan": _plan(before, move, facts, continuation),
            "continuation": continuation, "actualContinuation": actual, "correction": correction,
            "assessment": verdict["detail"] + " " + result["analysisNote"],
        })
        if self._reviewer.stopped(ident):
            result["cancelled"] = True
        return result
