"""Accuracy boundaries, native WDL provenance, and independent engine lifecycle."""

from __future__ import annotations

import concurrent.futures
import math
import os
from pathlib import Path
import shutil
import time
import unittest
from unittest.mock import Mock, patch
import uuid

import chess
import chess.engine

from accuracy import AccuracyError, AccuracyService, METHOD_VERSION, _classification, _metrics, _native_candidate, _terminal_candidate


ROOT = Path(__file__).resolve().parents[1]
ENGINE = shutil.which(os.environ.get("STOCKFISH_PATH") or str(ROOT / "engines" / "stockfish")) or shutil.which("stockfish")


def game(sans, fen=chess.STARTING_FEN):
    board = chess.Board(fen)
    for san in sans:
        board.push_san(san)
    return board


def frame(board, move, *, wins=600, draws=300, losses=100):
    return {
        "pv": [board.parse_san(move)], "depth": 12,
        "score": chess.engine.PovScore(chess.engine.Cp(50), chess.WHITE),
        "wdl": chess.engine.PovWdl(chess.engine.Wdl(wins, draws, losses), chess.WHITE),
    }


class AccuracyRulesTest(unittest.TestCase):
    def test_published_category_boundaries_are_not_rounded(self):
        for loss, expected in [
            (0, "Best"), (0.000001, "Excellent"), (0.0199999, "Excellent"),
            (0.02, "Good"), (0.0499999, "Good"), (0.05, "Inaccuracy"),
            (0.0999999, "Inaccuracy"), (0.10, "Mistake"),
            (0.1999999, "Mistake"), (0.20, "Blunder"), (1, "Blunder"),
        ]:
            with self.subTest(loss=loss):
                self.assertEqual(_classification(loss), expected)
        self.assertEqual(_metrics(0.55, 0.5)["classification"], "Inaccuracy")
        self.assertEqual(_metrics(0.6, 0.5)["classification"], "Mistake")
        self.assertEqual(_metrics(0.7, 0.5)["classification"], "Blunder")

    def test_local_curve_is_bounded_monotonic_and_clamps_search_noise(self):
        results = [_metrics(1, index / 100) for index in range(101)]
        scores = [result["moveAccuracy"] for result in results]
        self.assertEqual(scores[0], 0)
        self.assertEqual(scores[-1], 100)
        self.assertEqual(sorted(scores), scores)
        for result in results:
            self.assertTrue(math.isfinite(result["moveAccuracy"]))
        noise = _metrics(0.60, 0.61)
        self.assertEqual(noise["expectedPointsBefore"], 0.61)
        self.assertEqual(noise["expectedPointsLoss"], 0)
        self.assertEqual(noise["moveAccuracy"], 100)

    def test_white_and_black_use_actual_movers_native_expectation(self):
        white = chess.Board()
        black = game(["e4"])
        self.assertEqual(_native_candidate(white, frame(white, "e4"))["expected"], 0.75)
        result = _native_candidate(black, frame(black, "e5"))
        self.assertEqual(result["expected"], 0.25)
        self.assertEqual(result["wdl"], {"wins": 100, "draws": 300, "losses": 600})
        self.assertEqual(result["score"], {"cp": 50, "mate": None})

    def test_missing_bounded_invalid_or_wrong_root_scores_are_unscored(self):
        board = chess.Board()
        info = frame(board, "e4")
        for key in ["wdl", "score", "pv"]:
            incomplete = dict(info)
            del incomplete[key]
            self.assertIsNone(_native_candidate(board, incomplete))
        for key in ["lowerbound", "upperbound"]:
            self.assertIsNone(_native_candidate(board, dict(info, **{key: True})))
        self.assertIsNone(_native_candidate(board, info, board.parse_san("d4")))
        self.assertIsNone(_native_candidate(board, dict(info, pv=[chess.Move.from_uci("a1a8")])))
        self.assertIsNone(_native_candidate(board, frame(board, "e4", wins=100, draws=100, losses=100)))

    def test_terminal_mate_has_exact_outcome_for_both_colors(self):
        for board, san in [(game(["f3", "e5", "g4"]), "Qh4#"),
                           (game(["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"]), "Qxf7#")]:
            with self.subTest(color=board.turn):
                result = _terminal_candidate(board, board.parse_san(san))
                self.assertEqual(result["expected"], 1)
                self.assertEqual(result["source"], "exact-outcome")
                self.assertEqual(result["wdl"], {"wins": 1000, "draws": 0, "losses": 0})

    def test_terminal_draw_uses_actual_history_for_fivefold_repetition(self):
        board = game(["Nf3", "Nf6", "Ng1", "Ng8"] * 3 + ["Nf3", "Nf6", "Ng1"])
        move = board.parse_san("Ng8")
        self.assertIsNone(board.outcome(claim_draw=False))
        self.assertEqual(_terminal_candidate(board, move)["expected"], 0.5)
        self.assertIsNone(_terminal_candidate(board.copy(stack=False), move))

    def test_stalemate_insufficient_material_and_seventyfive_moves_are_exact_draws(self):
        for fen, san in [
            ("7k/5K2/8/6Q1/8/8/8/8 w - - 0 1", "Qg6"),
            ("7k/8/8/8/8/8/1r6/K7 w - - 0 1", "Kxb2"),
            ("7k/8/8/8/8/8/8/KR6 w - - 149 76", "Rb2"),
        ]:
            with self.subTest(san=san):
                board = chess.Board(fen)
                result = _terminal_candidate(board, board.parse_san(san))
                self.assertEqual(result["expected"], 0.5)
                self.assertEqual(result["wdl"], {"wins": 0, "draws": 1000, "losses": 0})

    def test_invalid_selected_move_fails_without_starting_engine(self):
        service = AccuracyService(None)
        for ply in [0, -1, 2, True, 1.5]:
            with self.subTest(ply=ply), self.assertRaises(AccuracyError):
                service.review(game(["e4"]), uuid.uuid4().hex, ply)

    def test_precancelled_request_returns_no_fabricated_score_without_engine(self):
        service = AccuracyService(None)
        ident = uuid.uuid4().hex
        service.stop(ident)
        result = service.review(game(["e4"]), ident, 1)
        self.assertTrue(result["cancelled"])
        self.assertFalse(result["scored"])
        self.assertIsNone(result["moveAccuracy"])

    def test_report_does_not_turn_missing_engine_scores_into_perfect_accuracy(self):
        service = AccuracyService(None)
        engine = Mock()
        engine.options = {name: None for name in ["Threads", "Hash", "Skill Level", "UCI_LimitStrength", "UCI_ShowWDL"]}
        engine.id = {"name": "missing-WDL test engine"}
        with patch.object(service, "_get_engine", return_value=engine), patch.object(service, "_search", return_value=None):
            result = service.review(game(["e4"]), uuid.uuid4().hex, 1)
        self.assertFalse(result["scored"])
        self.assertFalse(result["cancelled"])
        self.assertIsNone(result["moveAccuracy"])
        self.assertIsNone(result["classification"])
        self.assertIsNone(result["expectedPointsLoss"])
        self.assertIn("Retry", result["unavailableReason"])
        engine.configure.assert_called_once_with({"Threads": 1, "Hash": 32, "Skill Level": 20, "UCI_LimitStrength": False, "UCI_ShowWDL": True})


@unittest.skipUnless(ENGINE, "A real Stockfish executable is required")
class AccuracyRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = AccuracyService(ENGINE)

    @classmethod
    def tearDownClass(cls):
        cls.service.close()

    def review(self, board, ply=None):
        return self.service.review(board, uuid.uuid4().hex, ply or len(board.move_stack))

    def test_white_mating_blunder_and_black_checkmate(self):
        board = game(["f3", "e5", "g4", "Qh4#"])
        blunder = self.review(board, 3)
        self.assertTrue(blunder["scored"], blunder)
        self.assertEqual(blunder["classification"], "Blunder")
        self.assertEqual(blunder["expectedPointsAfter"], 0)
        self.assertGreaterEqual(blunder["expectedPointsLoss"], 0.2)
        self.assertNotEqual(blunder["bestMove"], "g2g4")
        mate = self.review(board, 4)
        self.assertEqual(mate["classification"], "Best")
        self.assertEqual(mate["moveAccuracy"], 100)
        self.assertEqual(mate["expectedPointsAfter"], 1)
        self.assertEqual(mate["scoreSource"], "exact-outcome")

    def test_black_mating_blunder_is_not_scored_from_white_perspective(self):
        board = game(["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"])
        result = self.review(board, 6)
        self.assertTrue(result["scored"], result)
        self.assertEqual(result["move"]["color"], "black")
        self.assertEqual(result["classification"], "Blunder")
        self.assertEqual(result["expectedPointsAfter"], 0)
        self.assertGreater(result["score"]["mate"], 0)

    def test_full_strength_metadata_full_history_and_input_unchanged(self):
        board = game(["e4", "e5", "Nf3", "Nc6"])
        fen, moves = board.fen(), list(board.move_stack)
        result = self.review(board, 2)
        self.assertTrue(result["scored"], result)
        self.assertEqual(result["initialFen"], chess.STARTING_FEN)
        self.assertEqual(result["moves"], [move.uci() for move in moves])
        self.assertEqual(result["afterFen"], game(["e4", "e5"]).fen())
        self.assertEqual(result["positionFen"], result["afterFen"])
        self.assertEqual(result["strength"], 100)
        self.assertFalse(result["forgiving"])
        self.assertEqual(result["skillLevel"], 20)
        self.assertEqual(result["methodVersion"], METHOD_VERSION)
        self.assertIn("not Chess.com CAPS2", result["methodNote"])
        self.assertEqual(sum(result["wdlAfter"].values()), 1000)
        self.assertEqual(board.fen(), fen)
        self.assertEqual(board.move_stack, moves)

    def test_forced_only_move_drawing_capture_is_best_for_both_colors(self):
        position = chess.Board("7k/8/8/8/8/8/1r6/K7 w - - 0 1")
        for before in [position, position.mirror()]:
            with self.subTest(color=before.turn):
                self.assertEqual(before.legal_moves.count(), 1)
                board = before.copy()
                board.push(next(iter(before.legal_moves)))
                result = self.review(board)
                self.assertEqual(result["moveAccuracy"], 100)
                self.assertEqual(result["expectedPointsBefore"], 0.5)
                self.assertEqual(result["expectedPointsAfter"], 0.5)

    def test_stalemating_a_won_position_loses_half_an_expected_point(self):
        board = game(["Qg6"], "7k/5K2/8/6Q1/8/8/8/8 w - - 0 1")
        result = self.review(board)
        self.assertTrue(result["scored"], result)
        self.assertEqual(result["expectedPointsBefore"], 1)
        self.assertEqual(result["expectedPointsAfter"], 0.5)
        self.assertEqual(result["classification"], "Blunder")

    def test_automatic_seventyfive_move_draw_scores_best_and_played_equally(self):
        board = game(["Rb2"], "7k/8/8/8/8/8/8/KR6 w - - 149 76")
        result = self.review(board)
        self.assertTrue(result["scored"], result)
        self.assertEqual(result["expectedPointsBefore"], 0.5)
        self.assertEqual(result["expectedPointsAfter"], 0.5)
        self.assertEqual(result["classification"], "Best")

    def test_cancel_during_search_and_latest_request_wins(self):
        board = game(["e4", "e5", "Nf3"])
        for replace in [False, True]:
            with self.subTest(replace=replace):
                ident = uuid.uuid4().hex
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    pending = pool.submit(self.service.review, board, ident, 3)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        with self.service._state_lock:
                            running = self.service._active_id == ident and self.service._analysis is not None
                        if running:
                            break
                        time.sleep(0.005)
                    self.assertTrue(running, "Native accuracy search should start")
                    if replace:
                        replacement = pool.submit(self.service.review, board, uuid.uuid4().hex, 2)
                    else:
                        self.assertTrue(self.service.stop(ident)["stopped"])
                    self.assertTrue(pending.result(timeout=4)["cancelled"])
                    if replace:
                        self.assertTrue(replacement.result(timeout=4)["scored"])

    def test_accuracy_stop_does_not_interrupt_independent_native_engine(self):
        playing = chess.engine.SimpleEngine.popen_uci(ENGINE)
        try:
            with playing.analysis(chess.Board(), chess.engine.Limit(time=5)) as live:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    finished = pool.submit(live.wait)
                    ident = uuid.uuid4().hex
                    self.service.stop(ident)
                    cancelled = self.service.review(game(["e4"]), ident, 1)
                    self.assertTrue(cancelled["cancelled"])
                    self.assertFalse(finished.done(), "Playing search remains active")
                    live.stop()
                    self.assertIsNotNone(finished.result(timeout=3))
        finally:
            playing.quit()


if __name__ == "__main__":
    unittest.main()
