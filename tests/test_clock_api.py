"""Clock adjudication and short engine searches for fifteen-minute games."""

from __future__ import annotations

import io
import unittest
import uuid

import chess
import chess.pgn

from server import APIError, StockfishService, timeout_payload
import test_solver as test_support


class ClockPayloadTest(unittest.TestCase):
    def test_white_flag_and_export_preserve_history(self):
        moves = ["e2e4", "e7e5"]
        result = timeout_payload({"moves": moves, "flagged": "white"})
        self.assertEqual(result["outcome"], {
            "result": "0-1", "winner": "black", "reason": "time forfeit",
        })
        self.assertEqual(result["moves"], moves)
        self.assertEqual(result["legalMoves"], [])
        self.assertIsNone(result["claimableDraw"])
        exported = chess.pgn.read_game(io.StringIO(result["pgn"]))
        self.assertEqual(exported.headers["Result"], "0-1")
        self.assertEqual(exported.headers["Termination"], "time forfeit")
        self.assertEqual(exported.headers["TimeControl"], "900+0")
        self.assertEqual([move.uci() for move in exported.mainline_moves()], moves)
        self.assertTrue(result["pgn"].endswith("0-1"))

    def test_black_flag_awards_white_win(self):
        result = timeout_payload({"moves": ["e2e4"], "flagged": "black"})
        self.assertEqual(result["outcome"]["result"], "1-0")
        self.assertEqual(result["outcome"]["winner"], "white")

    def test_flag_is_draw_when_opponent_has_only_king(self):
        result = timeout_payload({
            "initialFen": "7k/8/8/8/8/8/Q7/K7 w - - 0 1",
            "moves": [], "flagged": "white",
        })
        self.assertEqual(result["outcome"], {
            "result": "1/2-1/2", "winner": None,
            "reason": "time forfeit — insufficient mating material",
        })
        self.assertEqual(result["legalMoves"], [])
        exported = chess.pgn.read_game(io.StringIO(result["pgn"]))
        self.assertEqual(exported.headers["Result"], "1/2-1/2")
        self.assertEqual(exported.headers["Termination"], "time forfeit")

    def test_delivered_checkmate_takes_precedence_over_flag(self):
        moves = ["f2f3", "e7e5", "g2g4", "d8h4"]
        for flagged in ("white", "black"):
            with self.subTest(flagged=flagged):
                result = timeout_payload({"moves": moves, "flagged": flagged})
                self.assertEqual(result["outcome"], {
                    "result": "0-1", "winner": "black", "reason": "checkmate",
                })
                self.assertNotIn('[Termination "time forfeit"]', result["pgn"])

    def test_existing_draw_takes_precedence_over_flag(self):
        result = timeout_payload({
            "initialFen": "7k/8/8/8/8/8/8/K7 w - - 0 1",
            "moves": [], "flagged": "white",
        })
        self.assertEqual(result["outcome"]["reason"], "insufficient material")
        self.assertEqual(result["outcome"]["result"], "1/2-1/2")

    def test_reject_wrong_turn_and_invalid_flags(self):
        for flagged in ("black", "w", "", None, True, []):
            with self.subTest(flagged=flagged), self.assertRaises(APIError):
                timeout_payload({"moves": [], "flagged": flagged})

    def test_reject_illegal_history_and_history_past_checkmate(self):
        for moves in (["e2e5"], ["f2f3", "e7e5", "g2g4", "d8h4", "a2a3"]):
            with self.subTest(moves=moves), self.assertRaises(APIError):
                timeout_payload({"moves": moves, "flagged": "white"})

    def test_reject_nonpositive_and_out_of_range_search_time(self):
        service = StockfishService()
        try:
            for seconds in (0, -1, 0.001, 121, True, "0.5"):
                with self.subTest(seconds=seconds), self.assertRaises(APIError):
                    service.analyze({"moves": [], "requestId": str(uuid.uuid4()), "seconds": seconds})
        finally:
            service.close()


class ClockAPITest(unittest.TestCase):
    # Reuse the existing isolated HTTP-server fixture without inheriting its
    # complete test suite (which would execute every solver test twice).
    setUpClass = classmethod(test_support.SolverAPITest.setUpClass.__func__)
    tearDownClass = classmethod(test_support.SolverAPITest.tearDownClass.__func__)
    request = test_support.SolverAPITest.request
    post = test_support.SolverAPITest.post

    def test_timeout_endpoint_and_turn_validation(self):
        result = self.post("/api/timeout", {"moves": ["e2e4"], "flagged": "black"})
        self.assertEqual(result["outcome"]["result"], "1-0")
        self.assertEqual(result["legalMoves"], [])
        status, _ = self.request("/api/timeout", {"moves": ["e2e4"], "flagged": "white"})
        self.assertEqual(status, 400)

    def test_subsecond_search_returns_legal_move(self):
        for seconds in (0.01, 0.2):
            for target in (False, True):
                with self.subTest(seconds=seconds, accuracy_target=target):
                    result = self.post("/api/analyze", {
                        "moves": [], "requestId": str(uuid.uuid4()), "seconds": seconds,
                        "threads": 1, "hashMb": 16, "strength": 70,
                        "accuracyTarget": {"enabled": target},
                    })
                    self.assertIn(chess.Move.from_uci(result["bestMove"]), chess.Board().legal_moves)
                    self.assertFalse(result["cancelled"])

    def test_zero_and_negative_search_time_rejected(self):
        for seconds in (0, -0.1):
            with self.subTest(seconds=seconds):
                status, _ = self.request("/api/analyze", {
                    "moves": [], "requestId": str(uuid.uuid4()), "seconds": seconds,
                })
                self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
