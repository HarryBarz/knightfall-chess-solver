"""Observable board ideas and conditional, legal plans for learning arrows.

Current arrows describe geometry, with absolute pins filtered. They deliberately
do not turn an attack map into a claim that a capture wins material. Future
arrows belong to a single engine continuation from the real side to move.
"""

from __future__ import annotations

import chess


LOOKAHEAD_CHOICES = (2, 3, 4, 6)
CENTRE = (chess.D4, chess.E4, chess.D5, chess.E5)
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
OPENINGS = (
    ("King's Gambit", ("e2e4", "e7e5", "f2f4"), chess.F4),
    ("Queen's Gambit", ("d2d4", "d7d5", "c2c4"), chess.C4),
    ("Evans Gambit", ("e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "b2b4"), chess.B4),
)


def _side(color):
    return "white" if color else "black"


def _piece(board, square):
    piece = board.piece_at(square)
    return f"{chess.piece_name(piece.piece_type)} on {chess.square_name(square)}" if piece else chess.square_name(square)


def _join(items):
    return " and ".join(items) if len(items) < 3 else ", ".join(items[:-1]) + ", and " + items[-1]


def _pressure(board, square):
    """Geometric influence, excluding moves off an absolute pin's ray.

    No turn is invented here. Even filtered influence is not a legal-move list:
    checks, defended destinations, and intervening replies can change matters.
    """
    piece = board.piece_at(square)
    if piece is None:
        return set()
    return set(board.attacks(square) & board.pin(piece.color, square))


def _arrow(source, target, color, kind="attack", **extra):
    return {"from": chess.square_name(source), "to": chess.square_name(target),
            "color": _side(color), "kind": kind, **extra}


def _idea(ident, color, kind, title, explanation, arrows, priority, **extra):
    return {"id": ident, "color": _side(color), "kind": kind, "title": title,
            "explanation": explanation, "arrows": arrows[:4], "priority": priority, **extra}


def _recent_squares(board):
    recent = {}
    for index, move in enumerate(reversed(board.move_stack[-2:])):
        color = not board.turn if index == 0 else board.turn
        piece = board.piece_at(move.to_square)
        if piece and piece.color == color:
            recent[color] = move.to_square
    return recent


def _board_ideas(board):
    ideas = []
    recent = _recent_squares(board)
    occupied = board.piece_map()
    pressure = {source: _pressure(board, source) for source in occupied}
    for color in (chess.WHITE, chess.BLACK):
        side = _side(color).title()
        sources = [s for s, p in occupied.items() if p.color == color and p.piece_type != chess.KING]
        for source in sorted(sources):
            targets = sorted((s for s in pressure[source] if s in occupied and occupied[s].color != color),
                             key=lambda s: (occupied[s].piece_type == chess.KING, VALUES[occupied[s].piece_type]), reverse=True)
            source_name = _piece(board, source)
            important = [s for s in targets if occupied[s].piece_type != chess.PAWN]
            if len(important) >= 2:
                targets = important[:4]
                king = any(occupied[s].piece_type == chess.KING for s in targets)
                detail = " One arm is a check against the king; a king is never captured." if king else ""
                ideas.append(_idea(f"fork-{source}", color, "attack", f"{side}: a fork pattern",
                    f"The {source_name} applies pressure to {_join([_piece(board, s) for s in targets])} at once."
                    + detail + " This is a fork pattern, not proof of winning material: checks, captures, defenders, and the opponent's reply must still be considered.",
                    [_arrow(source, target, color) for target in targets], 91 + (source == recent.get(color))))
            elif targets:
                targets = targets[:3]
                check = occupied[targets[0]].piece_type == chess.KING
                title = f"{side}: check against the king" if check else f"{side}: pressure on {_join([chess.square_name(s) for s in targets])}"
                explanation = (f"The {source_name} checks the opposing king. This arrow marks check, never a king capture."
                               if check else f"The {source_name} attacks {_join([_piece(board, s) for s in targets])} geometrically. This shows pressure, not a guaranteed safe or profitable capture.")
                if color != board.turn and not check:
                    explanation += f" It is {_side(board.turn).title()}'s turn, so this is not an immediate move for {side}."
                elif board.is_check() and color == board.turn:
                    explanation += " This side must first answer the current check; an attack elsewhere may not be a legal reply."
                ideas.append(_idea(f"attack-{source}", color, "attack", title, explanation,
                    [_arrow(source, target, color) for target in targets], (97 if check else 64) + (8 if source == recent.get(color) else 0)))

            allies = sorted((s for s in pressure[source] if s in occupied and occupied[s].color == color
                             and occupied[s].piece_type != chess.KING), key=lambda s: VALUES[occupied[s].piece_type], reverse=True)
            # Show the moved piece's useful defensive connection instead of
            # filling the initial position with every pawn's support arrow.
            if allies and source == recent.get(color):
                allies = allies[:3]
                ideas.append(_idea(f"support-{source}", color, "support", f"{side}: pieces supporting each other",
                    f"From {chess.square_name(source)}, the {chess.piece_name(occupied[source].piece_type)} supports {_join([_piece(board, s) for s in allies])}. "
                    "These are defensive connections, not moves onto friendly pieces. A recapture still depends on checks, king safety, and the resulting position.",
                    [_arrow(source, target, color, "support") for target in allies], 71))

            central = [s for s in CENTRE if s in pressure[source] and s not in occupied]
            if central and (source == recent.get(color) or occupied[source].piece_type in (chess.KNIGHT, chess.BISHOP)):
                ideas.append(_idea(f"position-{source}", color, "position", f"{side}: influence over the center",
                    f"The {source_name} controls {_join([chess.square_name(s) for s in central])}. "
                    "This can support central play or restrict an opposing piece. Control is a positional idea, not a promise that moving there is best or legal next turn.",
                    [_arrow(source, target, color, "support") for target in central], 69 if source == recent.get(color) else 38))

        targets = [s for s, p in occupied.items() if p.color != color] + [s for s in CENTRE if s not in occupied]
        for target in targets:
            attackers = [s for s in sources if target in pressure[s]]
            if len(attackers) < 2:
                continue
            attackers.sort(key=lambda s: (s != recent.get(color), -VALUES[occupied[s].piece_type], s))
            attackers = attackers[:4]
            enemy = occupied.get(target)
            object_name = f"the {_piece(board, target)}" if enemy else f"the central square {chess.square_name(target)}"
            detail = " Against the king this is checking pressure, never a proposed king capture." if enemy and enemy.piece_type == chess.KING else ""
            ideas.append(_idea(f"coordination-{_side(color)}-{target}", color, "coordination", f"{side}: combined pressure on {chess.square_name(target)}",
                f"The {_join([_piece(board, s) for s in attackers])} converge on {object_name}. "
                "This is a concrete shared target for coordinated play; simply counting attackers does not establish a winning combination."
                + detail,
                [_arrow(source, target, color, "attack" if enemy else "support") for source in attackers], 88 if enemy else 56))

    if board.move_stack:
        previous = board.copy()
        last = previous.pop()
        color = previous.turn
        for source, piece in occupied.items():
            if piece.color != color or piece.piece_type not in (chess.BISHOP, chess.ROOK, chess.QUEEN):
                continue
            if source == last.to_square or previous.piece_at(source) != piece:
                continue
            targets = [s for s in pressure[source] - _pressure(previous, source)
                       if s in occupied and occupied[s].color != color]
            if targets:
                targets.sort(key=lambda s: (occupied[s].piece_type == chess.KING, VALUES[occupied[s].piece_type]), reverse=True)
                targets = targets[:4]
                ideas.append(_idea(f"discovered-{source}", color, "attack", f"{_side(color).title()}: an opened attack line",
                    f"The last move, {previous.san(last)}, opened the {chess.piece_name(piece.piece_type)}'s line from {chess.square_name(source)} to {_join([_piece(board, s) for s in targets])}. "
                    "The arrows show the newly available pressure; follow the opponent's replies before concluding that material is won.",
                    [_arrow(source, target, color) for target in targets], 94))
    return ideas


def _opening_ideas(board):
    if board.root().fen() != chess.STARTING_FEN:
        return []
    moves = tuple(move.uci() for move in board.move_stack)
    for name, prefix, offered_square in OPENINGS:
        if moves[:len(prefix)] != prefix:
            continue
        arrows = []
        pawn = board.piece_at(offered_square)
        if pawn == chess.Piece(chess.PAWN, chess.WHITE):
            arrows = [_arrow(offered_square, target, chess.WHITE)
                      for target in sorted(_pressure(board, offered_square))
                      if (piece := board.piece_at(target)) and piece.color == chess.BLACK]
        return [_idea("opening-gambit", chess.WHITE, "gambit", f"Opening context: {name}",
            f"The recorded moves from the standard starting position include the {name} pawn offer. "
            "This identifies opening history, not a new sacrifice or the player's private intention. The offer may already have been accepted, declined, or recovered; any arrows show only current pawn pressure. "
            + ("In the Queen's Gambit the offered pawn can often be recovered, so the name alone does not mean a permanent material sacrifice."
               if name == "Queen's Gambit" else "Development and central play can be reasons for an opening offer, but compensation is not established by the opening's name."), arrows, 76)]
    return []


def _captured_square(board, move):
    if board.is_en_passant(move):
        return move.to_square - 8 if board.turn == chess.WHITE else move.to_square + 8
    return move.to_square


def _move_explanation(before, move):
    piece = before.piece_at(move.from_square)
    san = before.san(move)
    after = before.copy(stack=False)
    after.push(move)
    if after.is_checkmate():
        return f"{_side(piece.color).title()} could play {san}, delivering checkmate; the king is in check and there is no legal reply."
    reasons = []
    if before.is_castling(move):
        reasons.append("castles, moving the king and rook together")
    elif before.is_capture(move):
        captured = before.piece_at(_captured_square(before, move))
        reasons.append(f"captures the {chess.piece_name(captured.piece_type)}" + (" en passant" if before.is_en_passant(move) else f" on {chess.square_name(move.to_square)}"))
    else:
        reasons.append(f"places the {chess.piece_name(piece.piece_type)} on {chess.square_name(move.to_square)}")
    if move.promotion:
        reasons.append(f"promotes the pawn to a {chess.piece_name(move.promotion)}")
    if before.is_check():
        reasons.append("answers the check against its own king")
    if after.is_check():
        reasons.append("gives check, so the opponent must answer the threat to its king")
    controlled = _pressure(after, move.to_square)
    targets = [s for s in sorted(controlled) if (enemy := after.piece_at(s))
               and enemy.color != piece.color and enemy.piece_type != chess.KING]
    if targets:
        reasons.append(f"puts pressure on {_join([_piece(after, s) for s in targets[:2]])}")
    elif central := [chess.square_name(s) for s in CENTRE if s in controlled]:
        reasons.append(f"influences {_join(central)} in the center")
    return f"{_side(piece.color).title()} could play {san}: " + "; ".join(reasons) + ". This belongs to the illustrated continuation, not a prediction of the actual reply."


def _line_steps(board, result, limit):
    """Never attach the strongest PV to a different skill-selected first move."""
    best = result.get("bestMove")
    try:
        first = chess.Move.from_uci(best) if isinstance(best, str) else None
    except ValueError:
        return []
    if first not in board.legal_moves or board.is_game_over(claim_draw=False):
        return []
    selected = next((line for line in result.get("lines", []) if line.get("move") == best), None)
    sans = selected.get("pv", []) if selected else []
    replay = board.copy()
    steps = []
    for index in range(limit):
        if replay.is_game_over(claim_draw=False):
            break
        if index == 0:
            move = first
            # A malformed or stale line is allowed to contribute no suffix.
            if sans:
                try:
                    if replay.parse_san(sans[0]) != first:
                        sans = []
                except (ValueError, TypeError):
                    sans = []
        else:
            if index >= len(sans):
                break
            try:
                move = replay.parse_san(sans[index])
            except (ValueError, TypeError):
                break
        if not move or move not in replay.legal_moves:
            break
        step = {"ply": index + 1, "move": move.uci(), "san": replay.san(move),
                "color": _side(replay.turn), "beforeFen": replay.fen(),
                "explanation": _move_explanation(replay, move)}
        replay.push(move)
        step["fen"] = replay.fen()
        steps.append(step)
    return steps


def _plan_ideas(steps):
    ideas = []
    for color in (chess.WHITE, chess.BLACK):
        side_steps = [step for step in steps if step["color"] == _side(color)]
        if not side_steps:
            continue
        arrows = []
        for step in side_steps:
            move = chess.Move.from_uci(step["move"])
            arrows.append(_arrow(move.from_square, move.to_square, color, "plan", step=step["ply"], beforeFen=step["beforeFen"]))
        sequence = " → ".join(f"{step['ply']}. {step['san']}" for step in steps)
        ideas.append(_idea(f"plan-{_side(color)}", color, "plan", f"{_side(color).title()}'s projected plan",
            f"One conditional line is {sequence}. Numbered arrows for {_side(color).title()} trace its moves within that alternating line; the opponent's replies are part of the sequence. "
            "A later arrow only applies after the earlier steps have been played. This suggests an observable plan, not knowledge of what the player had in mind.",
            arrows, 82, steps=side_steps))
    return ideas


def _material(board, color):
    return sum(VALUES[p.piece_type] for p in board.piece_map().values() if p.color == color)


def _offer_ideas(steps):
    for first, reply in zip(steps, steps[1:]):
        before = chess.Board(first["beforeFen"])
        middle = chess.Board(reply["beforeFen"])
        after = chess.Board(reply["fen"])
        move, response = chess.Move.from_uci(first["move"]), chess.Move.from_uci(reply["move"])
        color = before.turn
        if not middle.is_capture(response) or _captured_square(middle, response) != move.to_square:
            continue
        balance_before = _material(before, color) - _material(before, not color)
        balance_after = _material(after, color) - _material(after, not color)
        if balance_after >= balance_before:
            continue
        return [_idea(f"offer-{first['ply']}", color, "gambit", "Possible material offer in this line",
            f"In this conditional line, {_side(color).title()}'s {first['san']} is followed by {reply['san']}, capturing the piece that just moved. "
            "Across those two moves, the offering side loses material on the usual piece values. This could be a sacrifice or a mistake; compensation, later recovery, and deliberate intent are not established by these arrows.",
            [_arrow(move.from_square, move.to_square, color, "plan", step=first["ply"], beforeFen=first["beforeFen"])], 77,
            steps=[first, reply])]
    return []


def _select_ideas(ideas):
    """Reserve room for each side and its continuation, without a busy board."""
    chosen = [idea for idea in ideas if idea["kind"] == "plan" or idea["id"] == "opening-gambit"]
    remaining = sorted((idea for idea in ideas if idea not in chosen), key=lambda item: (-item["priority"], item["id"]))
    for color in ("white", "black"):
        allowance = 4 - sum(idea["color"] == color for idea in chosen)
        chosen.extend([idea for idea in remaining if idea["color"] == color][:allowance])
    for idea in remaining:
        if len(chosen) >= 8:
            break
        if idea not in chosen:
            chosen.append(idea)
    return sorted(chosen[:8], key=lambda item: (-item["priority"], item["id"]))


class ArrowService:
    def __init__(self, engine_service):
        self.engine = engine_service

    def analyze(self, board: chess.Board, ident: str, strength: int, forgiving: bool, lookahead: int) -> dict:
        if lookahead not in LOOKAHEAD_CHOICES:
            raise ValueError("Choose 2, 3, 4, or 6 half-moves for learning arrows.")
        initial_fen = board.root().fen()
        moves = [move.uci() for move in board.move_stack]
        result = self.engine.analyze({"initialFen": initial_fen, "moves": moves, "requestId": ident,
                                      "strength": strength, "forgiving": forgiving, "seconds": 1,
                                      "threads": 1, "hashMb": 32, "multiPv": 1})
        cancelled = bool(result.get("cancelled"))
        payload = {"requestId": ident, "initialFen": initial_fen, "moves": moves,
                   "positionFen": board.fen(), "strength": strength, "forgiving": forgiving,
                   "lookahead": lookahead, "cancelled": cancelled, "ideas": [], "line": [], "notes": []}
        if cancelled:
            return payload
        steps = _line_steps(board, result, lookahead)
        ideas = [*_board_ideas(board), *_opening_ideas(board), *_plan_ideas(steps), *_offer_ideas(steps)]
        payload.update(ideas=_select_ideas(ideas), line=steps, notes=[
            "Arrows explain observable pressure, support, and possible plans; they cannot reveal a player's private intention.",
            "Current-position arrows are geometric relationships, with absolute pins filtered. They do not guarantee a legal or profitable capture, especially while answering check or waiting for your turn.",
            "Numbered plan steps alternate between both sides. Each step is one player's move (a half-move), not a whole pair of turns; later arrows apply only after earlier steps.",
            f"The short engine continuation uses {strength}% strength" + (" with forgiving practice." if forgiving else ".")
            + " It is an illustration, not a guaranteed outcome or a measured accuracy percentage.",
        ])
        if board.is_game_over(claim_draw=False):
            payload["notes"].append("This position is terminal. There is no continuation; any remaining arrows describe the final board only.")
        elif len(steps) < lookahead:
            payload["notes"].append(f"The engine returned only {len(steps)} legal step(s), shorter than the requested {lookahead}. No extra moves were invented.")
        return payload

    def stop(self, ident):
        return self.engine.stop(ident)

    def close(self):
        self.engine.close()
