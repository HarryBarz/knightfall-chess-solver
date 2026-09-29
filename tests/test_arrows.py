"""Rule-driven learning-arrow checks plus execution against native Stockfish."""

from __future__ import annotations

import concurrent.futures
import os
from pathlib import Path
import shutil
import time
import unittest
import uuid

import chess

from arrows import ArrowService, _board_ideas, _line_steps, _offer_ideas, _opening_ideas, _pressure, _select_ideas


ROOT = Path(__file__).resolve().parents[1]
ENGINE_PATH = shutil.which(os.environ.get("STOCKFISH_PATH") or str(ROOT / "engines" / "stockfish")) or shutil.which("stockfish")


def game(sans, fen=chess.STARTING_FEN):
    board = chess.Board(fen)
    for san in sans:
        board.push_san(san)
    return board


def result_for(board, sans):
    if not sans:
        return {"bestMove": None, "lines": [], "cancelled": False}
    move = board.parse_san(sans[0]).uci()
    return {"bestMove": move, "lines": [{"move": move, "pv": sans}], "cancelled": False}


class RecordingEngine:
    def __init__(self, result=None, native=None):
        self.result = result or {"bestMove": None, "lines": [], "cancelled": False}
        self.native = native
        self.calls = []
        self.stops = []
        self.closed = False

    def analyze(self, data):
        self.calls.append(data)
        if self.native:
            self.result = self.native.analyze(data)
        return self.result

    def stop(self, ident):
        self.stops.append(ident)
        return self.native.stop(ident) if self.native else {"ok": True, "requestId": ident}

    def close(self):
        self.closed = True
        if self.native:
            self.native.close()


class ArrowRuleTest(unittest.TestCase):
    def assert_legal_steps(self, board, steps):
        replay = board.copy()
        for index, step in enumerate(steps, 1):
            self.assertEqual(step["ply"], index)
            self.assertEqual(step["beforeFen"], replay.fen())
            self.assertEqual(step["color"], "white" if replay.turn else "black")
            move = chess.Move.from_uci(step["move"])
            self.assertIn(move, replay.legal_moves)
            self.assertEqual(step["san"], replay.san(move))
            self.assertTrue(step["explanation"])
            replay.push(move)
            self.assertEqual(step["fen"], replay.fen())

    def test_absolute_pin_removes_knight_fork_outside_pin_ray(self):
        board = chess.Board("k3r3/8/8/2q5/4N3/8/8/4K3 w - - 0 1")
        self.assertTrue(board.is_valid())
        self.assertTrue(board.is_pinned(chess.WHITE, chess.E4))
        self.assertIn(chess.C5, board.attacks(chess.E4))
        self.assertEqual(_pressure(board, chess.E4), set())
        arrows = [arrow for idea in _board_ideas(board) for arrow in idea["arrows"]]
        self.assertNotIn(("e4", "c5"), [(arrow["from"], arrow["to"]) for arrow in arrows])

    def test_pinned_rook_keeps_pressure_along_pin_ray(self):
        board = chess.Board("k3r3/8/8/7q/4R3/8/8/4K3 w - - 0 1")
        self.assertTrue(board.is_valid())
        self.assertTrue(board.is_pinned(chess.WHITE, chess.E4))
        self.assertIn(chess.E8, _pressure(board, chess.E4))
        self.assertNotIn(chess.H4, _pressure(board, chess.E4))
        self.assertIn(chess.Move.from_uci("e4e8"), board.legal_moves)

    def test_combined_pressure_has_two_real_sources_and_one_target(self):
        board = game(["e4", "e5", "Bc4", "Nc6", "Qh5"])
        ideas = _board_ideas(board)
        shared = next(idea for idea in ideas if idea["id"] == "coordination-white-53")
        self.assertEqual(shared["kind"], "coordination")
        self.assertEqual({(arrow["from"], arrow["to"]) for arrow in shared["arrows"]}, {("h5", "f7"), ("c4", "f7")})
        self.assertIn("does not establish a winning combination", shared["explanation"])

    def test_both_sides_keep_fork_patterns_without_claiming_material_won(self):
        board = chess.Board("7k/8/8/2q1n1r1/2Q1N1R1/8/8/K7 w - - 0 1")
        self.assertTrue(board.is_valid())
        payload = ArrowService(RecordingEngine()).analyze(board, "forks", 70, False, 4)
        forks = [idea for idea in payload["ideas"] if "fork pattern" in idea["title"]]
        self.assertEqual({idea["color"] for idea in forks}, {"white", "black"})
        for idea in forks:
            self.assertGreaterEqual(len(idea["arrows"]), 2)
            self.assertIn("not proof", idea["explanation"])

    def test_check_arrow_never_proposes_a_king_capture(self):
        board = game(["f3", "e5", "g4", "Qh4#"])
        payload = ArrowService(RecordingEngine()).analyze(board, "mate", 100, False, 4)
        checks = [idea for idea in payload["ideas"] if "check against the king" in idea["title"]]
        self.assertTrue(checks)
        self.assertTrue(any(arrow["from"] == "h4" and arrow["to"] == "e1" for idea in checks for arrow in idea["arrows"]))
        self.assertIn("never a king capture", checks[0]["explanation"])
        self.assertEqual(payload["line"], [])
        self.assertTrue(any("terminal" in note for note in payload["notes"]))

    def test_in_check_pressure_is_not_called_a_legal_reply(self):
        board = chess.Board("k3r3/8/8/2q5/3N4/8/8/4K3 w - - 0 1")
        self.assertTrue(board.is_valid())
        self.assertTrue(board.is_check())
        # Nd4 attacks a queen on c6 only after relocating the fixture queen.
        board.remove_piece_at(chess.C5)
        board.set_piece_at(chess.C6, chess.Piece(chess.QUEEN, chess.BLACK))
        self.assertNotIn(chess.Move.from_uci("d4c6"), board.legal_moves)
        attacks = [idea for idea in _board_ideas(board) if idea["id"] == f"attack-{chess.D4}"]
        self.assertTrue(attacks)
        self.assertIn("must first answer the current check", attacks[0]["explanation"])

    def test_recent_piece_support_and_central_control_are_distinct(self):
        board = game(["e4", "e5", "Nf3"])
        ideas = _board_ideas(board)
        support = next(idea for idea in ideas if idea["id"] == f"support-{chess.F3}")
        position = next(idea for idea in ideas if idea["id"] == f"position-{chess.F3}")
        self.assertTrue(all(board.color_at(chess.parse_square(arrow["to"])) == chess.WHITE for arrow in support["arrows"]))
        self.assertTrue(all(board.piece_at(chess.parse_square(arrow["to"])) is None for arrow in position["arrows"]))
        self.assertIn("not moves onto friendly pieces", support["explanation"])

    def test_discovered_line_is_based_on_last_actual_move(self):
        board = game(["Bb5"], "k7/4q3/8/8/8/8/4B3/4R1K1 w - - 0 1")
        idea = next(idea for idea in _board_ideas(board) if idea["id"] == f"discovered-{chess.E1}")
        self.assertEqual([(a["from"], a["to"]) for a in idea["arrows"]], [("e1", "e7")])
        self.assertIn("Bb5", idea["explanation"])
        self.assertFalse(any(idea["id"].startswith("discovered-") for idea in _board_ideas(chess.Board(board.fen()))))

    def test_en_passant_can_open_a_rook_check_line(self):
        board = game(["exd6+"], "8/8/8/R2pP2k/8/8/8/K7 w - d6 0 2")
        self.assertTrue(board.is_check())
        self.assertIsNone(board.piece_at(chess.D5))
        idea = next(idea for idea in _board_ideas(board) if idea["id"] == f"discovered-{chess.A5}")
        self.assertEqual([(a["from"], a["to"]) for a in idea["arrows"]], [("a5", "h5")])

    def test_named_gambit_requires_exact_history_from_standard_root(self):
        for sans, name in [(["e4", "e5", "f4"], "King's Gambit"),
                           (["d4", "d5", "c4"], "Queen's Gambit"),
                           (["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"], "Evans Gambit")]:
            with self.subTest(name=name):
                board = game(sans)
                ideas = _opening_ideas(board)
                self.assertEqual(len(ideas), 1)
                self.assertIn(name, ideas[0]["title"])
                self.assertIn("history", ideas[0]["explanation"])
                self.assertEqual(_opening_ideas(chess.Board(board.fen())), [])
        self.assertEqual(_opening_ideas(game(["d4", "Nf6", "c4"])), [])

    def test_accepted_gambit_does_not_draw_departed_pawn(self):
        board = game(["e4", "e5", "f4", "exf4"])
        idea = _opening_ideas(board)[0]
        self.assertEqual(idea["arrows"], [])
        self.assertIn("may already have been accepted", idea["explanation"])

    def test_named_opening_context_survives_a_busy_board_idea_limit(self):
        opening = _opening_ideas(game(["d4", "d5", "c4"]))[0]
        busy = [{"id": f"{color}-{index}", "color": color, "kind": "attack", "priority": 99}
                for color in ("white", "black") for index in range(8)]
        selected = _select_ideas([opening, *busy])
        self.assertEqual(len(selected), 8)
        self.assertIn(opening, selected)
        self.assertEqual(sum(idea["color"] == "white" for idea in selected), 4)
        self.assertEqual(sum(idea["color"] == "black" for idea in selected), 4)

    def test_exact_selected_move_wins_over_unrelated_strongest_pv(self):
        board = chess.Board()
        response = {"bestMove": "a2a3", "lines": [{"move": "e2e4", "pv": ["e4", "e5", "Nf3"]}]}
        steps = _line_steps(board, response, 4)
        self.assertEqual([step["move"] for step in steps], ["a2a3"])
        self.assert_legal_steps(board, steps)
        response["lines"].append({"move": "a2a3", "pv": ["a3", "e5", "b4", "d5"]})
        steps = _line_steps(board, response, 4)
        self.assertEqual([step["san"] for step in steps], ["a3", "e5", "b4", "d5"])
        self.assert_legal_steps(board, steps)

    def test_invalid_and_null_pv_suffixes_cannot_be_shown(self):
        board = chess.Board()
        for sans in (["e4", "Ra8", "Nf3"], ["e4", "--", "Nf3"]):
            steps = _line_steps(board, result_for(board, sans), 4)
            self.assertEqual([step["move"] for step in steps], ["e2e4"])
        self.assertEqual(_line_steps(board, {"bestMove": "e1e8", "lines": []}, 4), [])
        self.assertEqual(_line_steps(board, {"bestMove": "nonsense", "lines": []}, 4), [])

    def test_underpromotion_is_preserved_in_line_and_explanation(self):
        board = chess.Board("7k/P6r/2K5/8/8/8/8/8 w - - 0 1")
        steps = _line_steps(board, result_for(board, ["a8=N", "Rh6+"]), 4)
        self.assertEqual(steps[0]["move"], "a7a8n")
        self.assertIn("promotes the pawn to a knight", steps[0]["explanation"])
        self.assert_legal_steps(board, steps)

    def test_en_passant_capture_and_castling_have_accurate_line_explanations(self):
        board = chess.Board("8/8/8/R2pP2k/8/8/8/K7 w - d6 0 2")
        steps = _line_steps(board, result_for(board, ["exd6+", "Kg4"]), 4)
        self.assertIn("captures the pawn en passant", steps[0]["explanation"])
        self.assert_legal_steps(board, steps)
        board = game(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"])
        steps = _line_steps(board, result_for(board, ["O-O", "Bc5"]), 4)
        self.assertIn("castles", steps[0]["explanation"])
        self.assert_legal_steps(board, steps)

    def test_checkmate_and_insufficient_material_stop_the_line(self):
        board = game(["f3", "e5", "g4"])
        steps = _line_steps(board, result_for(board, ["Qh4#", "e3"]), 4)
        self.assertEqual(len(steps), 1)
        self.assertIn("no legal reply", steps[0]["explanation"])
        board = chess.Board("7k/P7/2K5/8/8/8/8/8 w - - 0 1")
        steps = _line_steps(board, result_for(board, ["a8=N", "Kh7"]), 4)
        self.assertEqual(len(steps), 1)
        self.assertTrue(chess.Board(steps[-1]["fen"]).is_insufficient_material())

    def test_material_offer_requires_a_concrete_capture_and_material_loss(self):
        board = chess.Board("7k/8/8/1p6/8/8/8/3QK3 w - - 0 1")
        steps = _line_steps(board, result_for(board, ["Qa4", "bxa4"]), 4)
        self.assert_legal_steps(board, steps)
        offers = _offer_ideas(steps)
        self.assertEqual(len(offers), 1)
        self.assertIn("sacrifice or a mistake", offers[0]["explanation"])
        board = chess.Board("3q3k/8/8/3p4/4P3/8/8/7K w - - 0 1")
        exchange = _line_steps(board, result_for(board, ["exd5", "Qxd5"]), 4)
        self.assert_legal_steps(board, exchange)
        self.assertEqual(_offer_ideas(exchange), [])

    def test_bounded_plans_share_one_alternating_history_and_exact_settings(self):
        board = game(["e4", "e5"])
        original = board.fen(), list(board.move_stack)
        engine = RecordingEngine(result_for(board, ["Nf3", "Nc6", "Bc4", "Nf6", "d3", "Bc5"]))
        payload = ArrowService(engine).analyze(board, "practice", 30, True, 6)
        self.assertEqual(len(engine.calls), 1)
        request = engine.calls[0]
        self.assertEqual({key: request[key] for key in ("initialFen", "moves", "strength", "forgiving", "seconds", "multiPv")},
                         {"initialFen": chess.STARTING_FEN, "moves": ["e2e4", "e7e5"], "strength": 30,
                          "forgiving": True, "seconds": 1, "multiPv": 1})
        self.assertEqual((board.fen(), board.move_stack), original)
        self.assert_legal_steps(board, payload["line"])
        self.assertEqual(len(payload["line"]), 6)
        self.assertLessEqual(len(payload["ideas"]), 8)
        plans = [idea for idea in payload["ideas"] if idea["kind"] == "plan"]
        self.assertEqual({idea["color"] for idea in plans}, {"white", "black"})
        for idea in payload["ideas"]:
            self.assertLessEqual(len(idea["arrows"]), 4)
            for arrow in idea["arrows"]:
                at = chess.Board(arrow.get("beforeFen", board.fen()))
                source, target = chess.parse_square(arrow["from"]), chess.parse_square(arrow["to"])
                self.assertIsNotNone(at.piece_at(source))
                self.assertEqual("white" if at.color_at(source) else "black", arrow["color"])
                if arrow["kind"] != "plan":
                    self.assertIn(target, _pressure(at, source))
                else:
                    step = payload["line"][arrow["step"] - 1]
                    self.assertEqual(step["beforeFen"], arrow["beforeFen"])
        self.assertTrue(any("half-move" in note for note in payload["notes"]))

    def test_cancellation_removes_ideas_and_delegates_lifecycle(self):
        engine = RecordingEngine({"cancelled": True})
        service = ArrowService(engine)
        payload = service.analyze(chess.Board(), "cancel-me", 70, False, 4)
        self.assertTrue(payload["cancelled"])
        self.assertEqual(payload["ideas"], [])
        self.assertEqual(payload["line"], [])
        service.stop("cancel-me")
        service.close()
        self.assertEqual(engine.stops, ["cancel-me"])
        self.assertTrue(engine.closed)


@unittest.skipUnless(ENGINE_PATH, "A real Stockfish executable is required")
class NativeArrowTest(unittest.TestCase):
    def setUp(self):
        # Import here: server creates an ArrowService, but arrows has no server
        # import and importing this test must not introduce a circular import.
        from server import StockfishService
        self.engine = RecordingEngine(native=StockfishService())
        self.service = ArrowService(self.engine)

    def tearDown(self):
        self.service.close()

    def test_native_practice_selected_move_and_legal_pv(self):
        board = game(["e4", "e5", "Nf3", "Nc6"])
        before = board.fen(), list(board.move_stack)
        for strength, forgiving in ((30, True), (100, False)):
            with self.subTest(strength=strength):
                payload = self.service.analyze(board, uuid.uuid4().hex, strength, forgiving, 6)
                self.assertFalse(payload["cancelled"])
                self.assertEqual(payload["strength"], strength)
                self.assertEqual(payload["forgiving"], forgiving)
                self.assertEqual(payload["line"][0]["move"], self.engine.result["bestMove"])
                self.assertEqual(self.engine.result["skillLevel"], min((strength - 10) * 20 // 90, 4) if forgiving else (strength - 10) * 20 // 90)
                ArrowRuleTest.assert_legal_steps(self, board, payload["line"])
                self.assertGreater(len(payload["line"]), 0)
                self.assertLessEqual(len(payload["line"]), 6)
                self.assertEqual((board.fen(), board.move_stack), before)

    def test_native_terminal_and_mating_positions(self):
        board = game(["f3", "e5", "g4"])
        payload = self.service.analyze(board, uuid.uuid4().hex, 100, False, 4)
        self.assertEqual([step["san"] for step in payload["line"]], ["Qh4#"])
        board.push_san("Qh4#")
        terminal = self.service.analyze(board, uuid.uuid4().hex, 100, False, 4)
        self.assertEqual(terminal["line"], [])
        self.assertTrue(any("terminal" in note for note in terminal["notes"]))

    def test_stopping_native_arrows_does_not_stop_play_engine(self):
        from server import StockfishService
        play = StockfishService()
        arrow_id, play_id = uuid.uuid4().hex, uuid.uuid4().hex
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                play_future = pool.submit(play.analyze, {"requestId": play_id, "seconds": 1,
                                                        "threads": 1, "hashMb": 32})
                arrow_future = pool.submit(self.service.analyze, chess.Board(), arrow_id, 70, False, 4)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if self.engine.native._analysis is not None:
                        break
                    if arrow_future.done():
                        self.fail("Arrow search finished before the cancellation experiment ran")
                    time.sleep(0.01)
                self.assertIsNotNone(self.engine.native._analysis)
                self.service.stop(arrow_id)
                arrows, playing = arrow_future.result(timeout=10), play_future.result(timeout=10)
            self.assertTrue(arrows["cancelled"])
            self.assertEqual(arrows["ideas"], [])
            self.assertEqual(arrows["line"], [])
            self.assertFalse(playing["cancelled"])
            self.assertIn(chess.Move.from_uci(playing["bestMove"]), chess.Board().legal_moves)
            self.assertEqual(playing["requestId"], play_id)
        finally:
            play.close()


if __name__ == "__main__":
    unittest.main()
