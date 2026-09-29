"""Runtime checks for post-game teaching, legal branches and independent search."""

from __future__ import annotations

import concurrent.futures
import os
from pathlib import Path
import shutil
import time
import unittest
import uuid

import chess

from match_review import MatchReviewService, _best_line, _check_contrast, _facts, _steps, _verdict


ROOT = Path(__file__).resolve().parents[1]
ENGINE = shutil.which(os.environ.get("STOCKFISH_PATH") or str(ROOT / "engines" / "stockfish")) or shutil.which("stockfish")


def game(sans, fen=chess.STARTING_FEN):
    board = chess.Board(fen)
    for san in sans:
        board.push_san(san)
    return board


def candidate(move, cp=None, mate=None):
    return {"move": move, "san": move, "score": {"cp": cp, "mate": mate}}


class ReviewFactsTest(unittest.TestCase):
    def test_correction_explains_legal_answers_to_the_mating_threat(self):
        before = game(["f3", "e5"])
        played = before.parse_san("g4")
        after = before.copy()
        after.push(played)
        line = _steps(after, ["d8h4"], 4, projected=True)
        text = _check_contrast(before, played, before.parse_san("e3"), line)
        self.assertIn("Qh4#", text)
        self.assertIn("Ke2", text)
        self.assertIn("g3", text)
        self.assertIn("immediate check", text)
        self.assertEqual(_check_contrast(before, played, before.parse_san("e3"), []), "")

    def test_scores_are_compared_for_the_actual_mover(self):
        white_after = game(["e4"])
        black_after = game(["e4", "e5"])
        lines = [candidate("a", cp=100), candidate("b", cp=-200), candidate("c", cp=0)]
        self.assertEqual(_best_line(lines, chess.WHITE)["move"], "a")
        self.assertEqual(_best_line(lines, chess.BLACK)["move"], "b")
        self.assertEqual(_verdict(white_after, lines[1], lines[0])["lossCp"], 300)
        self.assertEqual(_verdict(black_after, lines[0], lines[1])["lossCp"], 300)
        self.assertEqual(_verdict(black_after, lines[1], lines[1])["label"], "Best reviewed move")

    def test_mate_ordering_never_becomes_a_pawn_loss(self):
        lines = [candidate("w2", mate=2), candidate("w5", mate=5), candidate("b2", mate=-2), candidate("b5", mate=-5), candidate("cp", cp=900)]
        self.assertEqual(_best_line(lines, chess.WHITE)["move"], "w2")
        self.assertEqual(_best_line(lines, chess.BLACK)["move"], "b2")
        result = _verdict(game(["e4", "e5"]), lines[4], lines[2])
        self.assertEqual(result["label"], "Missed mating line")
        self.assertIsNone(result["lossCp"])
        result = _verdict(game(["e4"]), lines[2], lines[4])
        self.assertEqual(result["label"], "Allows a mating line")
        self.assertIsNone(result["lossCp"])

    def test_small_score_differences_are_not_called_mistakes(self):
        verdict = _verdict(game(["e4"]), candidate("e4", cp=15), candidate("d4", cp=30))
        self.assertEqual(verdict["label"], "Close alternative")

    def test_terminal_mate_does_not_say_opponent_can_respond(self):
        before = game(["f3", "e5", "g4"])
        facts = _facts(before, before.parse_san("Qh4#"))
        self.assertEqual(len(facts), 1)
        self.assertIn("no legal reply", facts[0])

    def test_exchange_and_maneuver_connections_are_observable(self):
        before = game(["e4", "d5"])
        ucis = ["e4d5", "d8d5", "b1c3", "d5a5"]
        steps = _steps(before, ucis, 4, projected=True)
        self.assertIn("then captures", steps[0]["summary"])
        self.assertIn("recapture", steps[1]["summary"])
        self.assertIn("same queen's maneuver", steps[3]["summary"])
        self.assertIn("could play", steps[0]["summary"])
        actual = _steps(before, ucis, 4, projected=False)
        self.assertIn("White played", actual[0]["summary"])
        self.assertIn("In the game", actual[0]["summary"])

    def test_illegal_line_suffix_cannot_be_shown(self):
        steps = _steps(chess.Board(), ["e2e4", "a1a8", "g1f3"], 3, projected=True)
        self.assertEqual([step["move"] for step in steps], ["e2e4"])
        self.assertEqual(_steps(chess.Board(), ["not-a-move"], 3, projected=True), [])

    def test_passed_pawn_fact_uses_adjacent_files_and_direction(self):
        board = chess.Board("7k/8/8/3P4/8/8/8/K7 w - - 0 1")
        facts = _facts(board, board.parse_san("d6"))
        self.assertTrue(any("passed pawn" in fact for fact in facts))
        board = chess.Board("7k/4p3/8/3P4/8/8/8/K7 w - - 0 1")
        self.assertFalse(any("passed pawn" in fact for fact in _facts(board, board.parse_san("d6"))))


@unittest.skipUnless(ENGINE, "A real Stockfish executable is required")
class MatchReviewRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = MatchReviewService(lambda: ENGINE)

    @classmethod
    def tearDownClass(cls):
        cls.service.close()

    def review(self, board, ply, lookahead=8, **settings):
        return self.service.review(board, uuid.uuid4().hex, ply, lookahead, settings.get("strength", 100), settings.get("forgiving", False))

    def assert_legal_steps(self, start_fen, steps):
        board = chess.Board(start_fen)
        for index, step in enumerate(steps, 1):
            self.assertEqual(step["ply"], index)
            self.assertEqual(step["beforeFen"], board.fen())
            self.assertEqual(step["color"], "white" if board.turn else "black")
            move = chess.Move.from_uci(step["move"])
            self.assertIn(move, board.legal_moves)
            self.assertEqual(step["san"], board.san(move))
            self.assertTrue(step["reasons"])
            self.assertTrue(step["summary"])
            board.push(move)
            self.assertEqual(step["fen"], board.fen())

    def test_full_history_is_immutable_and_both_sides_have_legal_previews(self):
        board = game(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3", "Nf6"])
        original_fen, original_moves = board.fen(), list(board.move_stack)
        for ply, lookahead in [(1, 2), (2, 4), (3, 8)]:
            with self.subTest(ply=ply, lookahead=lookahead):
                result = self.review(board, ply, lookahead)
                self.assertFalse(result["cancelled"])
                self.assertEqual(result["moves"], [move.uci() for move in original_moves])
                self.assertEqual(result["ply"], ply)
                self.assertEqual(result["lookahead"], lookahead)
                self.assertEqual(result["positionFen"], result["afterFen"])
                self.assertEqual(result["initialFen"], chess.STARTING_FEN)
                self.assertGreater(len(result["continuation"]), 0)
                self.assertLessEqual(len(result["continuation"]), lookahead)
                if len(result["continuation"]) < lookahead:
                    self.assertIn("shorter", result["continuationNote"])
                self.assertEqual(len(result["actualContinuation"]), min(lookahead, len(original_moves) - ply))
                self.assert_legal_steps(result["afterFen"], result["continuation"])
                self.assert_legal_steps(result["afterFen"], result["actualContinuation"])
                if result["correction"]:
                    self.assert_legal_steps(result["beforeFen"], result["correction"]["continuation"])
                self.assertIn("not a claim", result["plan"])
                self.assertIn("conditional", result["plan"])
                self.assertIn("future", result["plan"])
                self.assertIn("one player's move", result["plan"])
        self.assertEqual(board.fen(), original_fen)
        self.assertEqual(board.move_stack, original_moves)

    def test_white_mating_error_and_black_checkmate_are_distinguished(self):
        board = game(["f3", "e5", "g4", "Qh4#"])
        mistake = self.review(board, 3)
        self.assertEqual(mistake["verdict"]["label"], "Allows a mating line")
        self.assertIsNone(mistake["verdict"]["lossCp"])
        self.assertEqual(mistake["continuation"][0]["san"], "Qh4#")
        self.assertEqual(len(mistake["continuation"]), 1)
        self.assertIsNotNone(mistake["correction"])
        self.assertNotEqual(mistake["correction"]["move"], "g2g4")
        self.assert_legal_steps(mistake["beforeFen"], mistake["correction"]["continuation"])
        mate = self.review(board, 4)
        self.assertEqual(mate["verdict"]["label"], "Checkmate")
        self.assertIsNone(mate["correction"])
        self.assertEqual(mate["continuation"], [])
        self.assertEqual(mate["actualContinuation"], [])
        self.assertIn("game ends here", mate["plan"])

    def test_black_mating_error_is_scored_from_black_perspective(self):
        board = game(["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"])
        result = self.review(board, 6)
        self.assertEqual(result["move"]["color"], "black")
        self.assertEqual(result["verdict"]["label"], "Allows a mating line")
        self.assertIn("for Black", result["verdict"]["detail"])
        self.assertGreater(result["played"]["score"]["mate"], 0)
        self.assertIsNone(result["verdict"]["lossCp"])
        self.assert_legal_steps(result["afterFen"], result["continuation"])
        self.assert_legal_steps(result["beforeFen"], result["correction"]["continuation"])

    def test_imported_root_and_selected_practice_strength_are_preserved(self):
        fen = chess.STARTING_FEN.replace(" w ", " b ").removesuffix("0 1") + "7 42"
        board = game(["e5", "Nf3", "Nc6"], fen)
        result = self.review(board, 1, 3, strength=30, forgiving=True)
        self.assertEqual(result["initialFen"], fen)
        self.assertEqual(result["beforeFen"], fen)
        self.assertEqual(result["move"]["color"], "black")
        self.assertEqual(result["strength"], 30)
        self.assertTrue(result["forgiving"])
        self.assertLessEqual(result["skillLevel"], 4)
        self.assert_legal_steps(result["afterFen"], result["continuation"])
        self.assert_legal_steps(result["afterFen"], result["actualContinuation"])

    def test_cancel_before_request_and_during_native_search(self):
        board = game(["e4", "e5"])
        ident = uuid.uuid4().hex
        self.service.stop(ident)
        cancelled = self.service.review(board, ident, 1, 4, 100, False)
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual(cancelled["moves"], ["e2e4", "e7e5"])
        self.assertEqual(cancelled["continuation"], [])
        ident = uuid.uuid4().hex
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.service.review, board, ident, 2, 8, 100, False)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                with self.service._reviewer._state_lock:
                    active = self.service._reviewer._active_id == ident and self.service._reviewer._analysis is not None
                if active:
                    break
                time.sleep(0.005)
            self.assertTrue(active, "Cancellation test must observe real active Stockfish analysis")
            stopped = self.service.stop(ident)
            self.assertTrue(stopped["stopped"])
            self.assertTrue(future.result(timeout=4)["cancelled"])
        self.assertFalse(self.review(board, 1, 2)["cancelled"])

    def test_meaningful_service_boundaries_are_validated(self):
        board = game(["e4"])
        for kwargs in [{"ply": 0}, {"ply": 2}, {"ply": True}, {"lookahead": 5}, {"lookahead": True}, {"strength": 101}, {"strength": True}, {"forgiving": 1}, {"ident": ""}]:
            args = {"board": board, "ident": uuid.uuid4().hex, "ply": 1, "lookahead": 4, "strength": 100, "forgiving": False, **kwargs}
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.service.review(**args)


if __name__ == "__main__":
    unittest.main()
