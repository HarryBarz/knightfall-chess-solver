#!/usr/bin/env python3
"""Local chess board with configurable Stockfish practice strength."""

from __future__ import annotations

import argparse
import atexit
from collections import OrderedDict
from contextlib import suppress
import io
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

try:
    import chess
    import chess.engine
    import chess.pgn
    import chess.svg
except ImportError as exc:
    raise SystemExit(
        "Missing Python dependency. Run: python3 -m pip install -r requirements.txt"
    ) from exc

from coach import CoachError, ExplainService
from match_review import MatchReviewService
from practice import PracticePlan


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
MAX_BODY_BYTES = 262_144
MAX_MOVES = 4096
MAX_THREADS = min(os.cpu_count() or 1, 32)
DEFAULT_THREADS = min(MAX_THREADS, max(1, (os.cpu_count() or 1) - 2), 8)


def memory_bytes() -> int:
    """Discover physical memory without introducing another dependency."""
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, AttributeError):
        try:
            return int(subprocess.check_output(
                ["sysctl", "-n", "hw.memsize"], timeout=2,
                stderr=subprocess.DEVNULL, text=True,
            ).strip())
        except (OSError, ValueError, subprocess.SubprocessError):
            return 2 * 1024**3


MAX_HASH_MB = min(4096, max(64, memory_bytes() // (4 * 1024**2)))
DEFAULT_HASH_MB = min(256, MAX_HASH_MB)


class APIError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def validate_fen(fen: object) -> chess.Board:
    if not isinstance(fen, str) or not fen.strip() or len(fen) > 512:
        raise APIError("Enter a valid FEN position.")
    try:
        board = chess.Board(fen.strip())
    except ValueError as exc:
        raise APIError(f"Invalid FEN: {exc}") from exc
    if not board.is_valid():
        raise APIError("Invalid chess position: check the kings, pawns, turn, and castling rights.")
    return board


def board_from_request(data: dict) -> chess.Board:
    board = validate_fen(data.get("initialFen", chess.STARTING_FEN))
    moves = data.get("moves", [])
    if not isinstance(moves, list) or len(moves) > MAX_MOVES:
        raise APIError(f"Moves must be an array containing at most {MAX_MOVES} moves.")
    for index, value in enumerate(moves):
        if not isinstance(value, str) or len(value) > 5:
            raise APIError(f"Move {index + 1} must use UCI notation, such as e2e4.")
        if board.is_game_over(claim_draw=False):
            raise APIError(f"Move {index + 1} occurs after the game has ended.")
        try:
            move = board.parse_uci(value)
            if not move or move not in board.legal_moves:
                raise ValueError("Null moves are not legal moves.")
            board.push(move)
        except ValueError as exc:
            raise APIError(f"Illegal move {index + 1}: {value}") from exc
    return board


def position_payload(board: chess.Board) -> dict:
    replay = board.root()
    initial_fen = replay.fen()
    history = []
    for move in board.move_stack:
        history.append({
            "uci": move.uci(),
            "san": replay.san(move),
            "turn": "white" if replay.turn else "black",
            "moveNumber": replay.fullmove_number,
            "beforeFen": replay.fen(),
        })
        replay.push(move)
        history[-1]["afterFen"] = replay.fen()
    outcome = board.outcome(claim_draw=False)
    outcome_data = None
    if outcome is not None:
        outcome_data = {
            "result": outcome.result(),
            "reason": outcome.termination.name.lower().replace("_", " "),
            "winner": None if outcome.winner is None else ("white" if outcome.winner else "black"),
        }
    claimable_draw = None
    if outcome is None:
        if board.can_claim_fifty_moves():
            claimable_draw = "fifty-move rule"
        elif board.can_claim_threefold_repetition():
            claimable_draw = "threefold repetition"
    game = chess.pgn.Game.from_board(board)
    return {
        "initialFen": initial_fen,
        "moves": [move.uci() for move in board.move_stack],
        "fen": board.fen(),
        "pieces": {
            chess.square_name(square): ("w" if piece.color else "b") + piece.symbol().upper()
            for square, piece in board.piece_map().items()
        },
        "legalMoves": [] if outcome is not None else [{
            "uci": move.uci(),
            "from": chess.square_name(move.from_square),
            "to": chess.square_name(move.to_square),
            "promotion": chess.piece_symbol(move.promotion) if move.promotion else None,
            "san": board.san(move),
        } for move in board.legal_moves],
        "history": history,
        "turn": "white" if board.turn else "black",
        "check": board.is_check(),
        "outcome": outcome_data,
        "claimableDraw": claimable_draw,
        "pgn": game.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=False)),
    }


def import_position(data: dict) -> chess.Board:
    if "fen" in data and "pgn" in data:
        raise APIError("Import either a FEN position or one PGN game.")
    if "fen" in data:
        return validate_fen(data["fen"])
    pgn = data.get("pgn")
    if not isinstance(pgn, str) or not pgn.strip():
        raise APIError("Paste a FEN position or a PGN game to import.")
    stream = io.StringIO(pgn)
    try:
        game = chess.pgn.read_game(stream)
        if game is None:
            raise APIError("No chess game was found in the PGN.")
        if game.errors:
            raise APIError(f"Invalid PGN: {game.errors[0]}")
        board = game.board()
        if board.chess960 or not board.is_valid() or type(board) is not chess.Board:
            raise APIError("Only valid standard chess positions are supported.")
        for index, move in enumerate(game.mainline_moves()):
            if index >= MAX_MOVES:
                raise APIError(f"A game may contain at most {MAX_MOVES} moves.")
            if board.is_game_over(claim_draw=False) or move not in board.legal_moves:
                raise APIError(f"Invalid PGN move {index + 1}.")
            board.push(move)
        if not board.move_stack and not re.search(r"\[\s*\w+\s+\"|(?:1-0|0-1|1/2-1/2|\*)", pgn):
            raise APIError("No valid PGN moves or headers were found.")
        if chess.pgn.read_game(stream) is not None:
            raise APIError("Import one PGN game at a time.")
        return board
    except APIError:
        raise
    except (ValueError, IndexError, RecursionError) as exc:
        raise APIError(f"Unable to read PGN: {exc}") from exc


def bounded_number(data: dict, key: str, default: float, lower: float, upper: float, *, integer: bool = False):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise APIError(f"{key} must be a number between {lower} and {upper}.")
    if value < lower or value > upper or (integer and int(value) != value):
        raise APIError(f"{key} must be {'an integer' if integer else 'a number'} between {lower} and {upper}.")
    return int(value) if integer else float(value)


def request_id(data: dict) -> str:
    value = data.get("requestId")
    if not isinstance(value, str) or not value or len(value) > 128:
        raise APIError("requestId must be a nonempty string of at most 128 characters.")
    return value


def white_score(score) -> dict:
    if score is None:
        return {"cp": None, "mate": None}
    white = score.white()
    return {"cp": white.score(), "mate": white.mate()}


class StockfishService:
    def __init__(self):
        self._analysis_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._engine = None
        self._engine_name = self._installed_engine_name()
        self._active_id = None
        self._analysis = None
        self._cancelled = OrderedDict()

    @staticmethod
    def _installed_engine_name() -> str:
        if not os.environ.get("STOCKFISH_PATH"):
            try:
                metadata = json.loads((ROOT / "engines" / "release.json").read_text())
                release = metadata.get("release", "")
                if isinstance(release, str) and re.fullmatch(r"sf_\d+(?:[._]\d+)*", release):
                    return "Stockfish " + release.removeprefix("sf_").replace("_", ".")
            except (OSError, ValueError, AttributeError):
                pass
        return "Stockfish"

    @staticmethod
    def engine_path() -> str | None:
        configured = os.environ.get("STOCKFISH_PATH")
        candidates = [configured] if configured else [str(ROOT / "engines" / "stockfish"), shutil.which("stockfish")]
        for candidate in candidates:
            if candidate:
                resolved = shutil.which(candidate)
                if resolved:
                    return resolved
        return None

    def health(self) -> dict:
        return {
            "ok": True,
            "engineAvailable": self.engine_path() is not None,
            "engineName": self._engine_name,
            "defaultThreads": DEFAULT_THREADS,
            "maxThreads": MAX_THREADS,
            "defaultHashMb": DEFAULT_HASH_MB,
            "maxHashMb": MAX_HASH_MB,
        }

    def _get_engine(self):
        if self._engine is None:
            path = self.engine_path()
            if path is None:
                raise APIError(
                    "Stockfish was not found. Run the setup script, or set STOCKFISH_PATH to an executable Stockfish binary.", 503,
                )
            try:
                self._engine = chess.engine.SimpleEngine.popen_uci(path, timeout=15)
                self._engine_name = self._engine.id.get("name", "Stockfish")
            except (OSError, chess.engine.EngineError, TimeoutError) as exc:
                raise APIError(f"Stockfish could not start: {exc}. Check STOCKFISH_PATH and the binary's architecture.", 503) from exc
        return self._engine

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

    def _empty_result(
        self, board: chess.Board, ident: str, cancelled: bool = False,
        *, strength: int = 100, forgiving: bool = False, skill_level: int = 20,
        practice: dict | None = None,
    ) -> dict:
        return {
            "requestId": ident,
            "positionFen": board.fen(),
            "bestMove": None,
            "bestSan": None,
            "score": {"cp": None, "mate": None},
            "lines": [], "depth": 0, "nodes": 0, "nps": 0, "timeMs": 0,
            "engine": self._engine_name, "cancelled": cancelled,
            "strength": strength, "forgiving": forgiving, "skillLevel": skill_level,
            "practice": practice,
        }

    def analyze(self, data: dict) -> dict:
        board = board_from_request(data)
        ident = request_id(data)
        seconds = bounded_number(data, "seconds", 3, 1, 120)
        threads = bounded_number(data, "threads", DEFAULT_THREADS, 1, MAX_THREADS, integer=True)
        hash_mb = bounded_number(data, "hashMb", DEFAULT_HASH_MB, 16, MAX_HASH_MB, integer=True)
        multi_pv = bounded_number(data, "multiPv", 1, 1, 3, integer=True)
        strength = bounded_number(data, "strength", 100, 10, 100, integer=True)
        forgiving = data.get("forgiving", False)
        if not isinstance(forgiving, bool):
            raise APIError("forgiving must be true or false.")
        if strength == 100 and forgiving:
            raise APIError("Choose a strength below 100 to enable forgiving practice.")
        try:
            practice = PracticePlan.from_request(data, board)
        except ValueError as exc:
            raise APIError(str(exc)) from exc
        skill_level = (strength - 10) * 20 // 90
        if forgiving:
            skill_level = min(skill_level, 4)
        settings = {"strength": strength, "forgiving": forgiving, "skill_level": skill_level,
                    "practice": practice.payload()}
        search_pv = max(multi_pv, 4) if skill_level < 20 else multi_pv
        if practice.eligible:
            search_pv = max(search_pv, 8)
        if not self._analysis_lock.acquire(blocking=False):
            raise APIError("Stockfish is already thinking. Stop the current search before starting another.", 409)
        started = time.monotonic()
        try:
            with self._state_lock:
                self._active_id = ident
                if ident in self._cancelled:
                    return self._empty_result(board, ident, cancelled=True, **settings)
            if board.is_game_over(claim_draw=False):
                return self._empty_result(board, ident, **settings)
            engine = self._get_engine()
            if skill_level < 20 or practice.eligible:
                if "Skill Level" not in engine.options or engine.options["Skill Level"].type != "spin":
                    raise APIError("This engine does not support the requested practice options. Use Stockfish.", 503)
                try:
                    engine.options["Skill Level"].parse(skill_level)
                    if "MultiPV" not in engine.options:
                        raise chess.engine.EngineError("MultiPV is unavailable")
                    engine.options["MultiPV"].parse(search_pv)
                except chess.engine.EngineError as exc:
                    raise APIError(f"This engine does not support the requested practice strength: {exc}. Use Stockfish.", 503) from exc
            options = {"Threads": threads, "Hash": hash_mb}
            if "UCI_LimitStrength" in engine.options:
                options["UCI_LimitStrength"] = False
            if "Skill Level" in engine.options:
                options["Skill Level"] = skill_level
            engine.configure(options)
            with self._state_lock:
                if ident in self._cancelled:
                    return self._empty_result(board, ident, cancelled=True, **settings)
            with engine.analysis(board, chess.engine.Limit(time=seconds), multipv=search_pv) as analysis:
                with self._state_lock:
                    self._analysis = analysis
                    already_cancelled = ident in self._cancelled
                if already_cancelled:
                    analysis.stop()
                for _ in analysis:
                    pass
                best = analysis.wait()
                infos = analysis.multipv
            best_move = best.move if best.move in board.legal_moves else None
            with self._state_lock:
                cancelled = ident in self._cancelled
            chosen = None if cancelled else practice.choose(board, infos, best_move)
            if chosen is not None:
                best_move = chosen["pv"][0]
                settings["practice"] = practice.payload(chosen)
            lines = []
            for info in infos:
                pv = info.get("pv", [])
                replay = board.copy(stack=False)
                san_pv = []
                for move in pv:
                    if move not in replay.legal_moves:
                        break
                    san_pv.append(replay.san(move))
                    replay.push(move)
                if san_pv:
                    lines.append({
                        "move": pv[0].uci(), "san": san_pv[0], "pv": san_pv,
                        "score": white_score(info.get("score")), "depth": info.get("depth", 0),
                    })
            # Skill Level can choose a move outside the engine's highest-scoring PV.
            selected_info = next((info for info in infos if best_move and info.get("pv") and info["pv"][0] == best_move), {})
            selected_line = next((line for line in lines if best_move and line["move"] == best_move.uci()), None)
            if selected_line is not None:
                lines.remove(selected_line)
                lines.insert(0, selected_line)
            main_info = selected_info or (infos[0] if infos else {})
            with self._state_lock:
                cancelled = ident in self._cancelled
            if cancelled:
                settings["practice"] = practice.payload()
            result = self._empty_result(board, ident, cancelled, **settings)
            result.update({
                "bestMove": best_move.uci() if best_move else None,
                "bestSan": board.san(best_move) if best_move else None,
                "score": white_score(selected_info.get("score")),
                "lines": lines[:multi_pv], "depth": main_info.get("depth", 0),
                "nodes": main_info.get("nodes", 0), "nps": main_info.get("nps", 0),
                "timeMs": round((time.monotonic() - started) * 1000),
            })
            return result
        except (chess.engine.EngineError, OSError, TimeoutError) as exc:
            self.close()
            raise APIError(f"Stockfish stopped unexpectedly: {exc}. Try again, or check your engine installation.", 503) from exc
        finally:
            with self._state_lock:
                self._analysis = None
                self._active_id = None
            self._analysis_lock.release()

    def close(self):
        engine, self._engine = self._engine, None
        if engine is not None:
            with suppress(Exception):
                engine.close()


ENGINE = StockfishService()
COACH = ExplainService(StockfishService.engine_path)
REVIEW = MatchReviewService(StockfishService.engine_path)
atexit.register(ENGINE.close)
atexit.register(COACH.close)
atexit.register(REVIEW.close)


class Handler(BaseHTTPRequestHandler):
    server_version = "ChessSolver/1.0"

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        with suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(body)

    def _json(self, status: int, value: dict):
        self._send(status, json.dumps(value, allow_nan=False).encode(), "application/json; charset=utf-8")

    def _check_local_request(self):
        port = self.server.server_address[1]
        expected_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            expected_hosts.update({"127.0.0.1", "localhost"})
        if self.headers.get("Host", "").lower() not in expected_hosts:
            raise APIError("This server accepts localhost requests only.", 403)
        origin = self.headers.get("Origin")
        if origin is not None and origin != f"http://{self.headers.get('Host')}":
            raise APIError("Cross-origin requests are not allowed.", 403)

    def _read_json(self) -> dict:
        if self.headers.get("Transfer-Encoding"):
            raise APIError("Chunked requests are not supported.", 400)
        if self.headers.get_content_type() != "application/json":
            raise APIError("Send the request as application/json.", 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise APIError("Invalid request length.") from exc
        if length <= 0 or length > MAX_BODY_BYTES:
            raise APIError(f"Request body must contain 1–{MAX_BODY_BYTES} bytes.", 413)
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError) as exc:
            raise APIError("Request body must be valid JSON.") from exc
        if not isinstance(data, dict):
            raise APIError("Request body must be a JSON object.")
        return data

    def do_GET(self):
        try:
            self._check_local_request()
            path = unquote(urlsplit(self.path).path)
            if path == "/api/health":
                self._json(200, ENGINE.health())
                return
            piece_match = re.fullmatch(r"/api/pieces/([wb])([PNBRQK])\.svg", path)
            if piece_match:
                color, symbol = piece_match.groups()
                piece = chess.Piece.from_symbol(symbol if color == "w" else symbol.lower())
                self._send(200, chess.svg.piece(piece, size=96).encode(), "image/svg+xml")
                return
            if path.startswith("/api/"):
                raise APIError("Unknown API endpoint.", 404)
            relative = "index.html" if path == "/" else path.lstrip("/")
            file_path = (WEB_ROOT / relative).resolve()
            if not file_path.is_relative_to(WEB_ROOT.resolve()) or not file_path.is_file():
                raise APIError("File not found.", 404)
            content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
                content_type += "; charset=utf-8"
            self._send(200, file_path.read_bytes(), content_type)
        except APIError as exc:
            self._json(exc.status, {"error": str(exc)})
        except (OSError, ValueError) as exc:
            self.log_error("GET failed: %s", exc)
            self._json(500, {"error": "The requested file could not be read."})

    def do_POST(self):
        try:
            self._check_local_request()
            data = self._read_json()
            path = urlsplit(self.path).path
            if path == "/api/position":
                result = position_payload(board_from_request(data))
            elif path == "/api/move":
                board = board_from_request(data)
                if len(board.move_stack) >= MAX_MOVES:
                    raise APIError(f"A game may contain at most {MAX_MOVES} moves.")
                if board.is_game_over(claim_draw=False):
                    raise APIError("This game has ended. Start a new game or undo a move.")
                value = data.get("move")
                if not isinstance(value, str) or not value.strip() or len(value) > 32:
                    raise APIError("Enter a move such as e4, Nf3, O-O, or e2e4.")
                value = value.strip()
                try:
                    try:
                        move = board.parse_uci(value.lower())
                    except ValueError:
                        move = board.parse_san(value)
                    if not move or move not in board.legal_moves:
                        raise ValueError("Null moves are not legal moves.")
                    board.push(move)
                except ValueError as exc:
                    raise APIError(f"Illegal or ambiguous move: {value}") from exc
                result = position_payload(board)
            elif path == "/api/import":
                result = position_payload(import_position(data))
            elif path == "/api/analyze":
                result = ENGINE.analyze(data)
            elif path == "/api/stop":
                result = ENGINE.stop(request_id(data))
            elif path == "/api/explain":
                board = board_from_request(data)
                ident = request_id(data)
                strength = bounded_number(data, "strength", 70, 10, 100, integer=True)
                forgiving = data.get("forgiving", False)
                if not isinstance(forgiving, bool):
                    raise APIError("forgiving must be true or false.")
                if strength == 100 and forgiving:
                    raise APIError("Choose a strength below 100 to enable forgiving practice.")
                result = COACH.explain(board, ident, strength, forgiving)
            elif path == "/api/explain/stop":
                result = COACH.stop(request_id(data))
            elif path == "/api/review":
                board = board_from_request(data)
                if not board.move_stack:
                    raise APIError("This position has no recorded moves to review.")
                ident = request_id(data)
                ply = bounded_number(data, "ply", len(board.move_stack), 1, len(board.move_stack), integer=True)
                lookahead = bounded_number(data, "lookahead", 4, 2, 8, integer=True)
                if lookahead not in (2, 3, 4, 6, 8):
                    raise APIError("Choose 2, 3, 4, 6, or 8 turns of lookahead.")
                strength = bounded_number(data, "strength", 70, 10, 100, integer=True)
                forgiving = data.get("forgiving", False)
                if not isinstance(forgiving, bool):
                    raise APIError("forgiving must be true or false.")
                if strength == 100 and forgiving:
                    raise APIError("Full-strength review cannot use forgiving mode.")
                result = REVIEW.review(board, ident, ply, lookahead, strength, forgiving)
            elif path == "/api/review/stop":
                result = REVIEW.stop(request_id(data))
            else:
                raise APIError("Unknown API endpoint.", 404)
            self._json(200, result)
        except APIError as exc:
            self._json(exc.status, {"error": str(exc)})
        except CoachError as exc:
            self._json(503, {"error": str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_error("POST failed: %s", exc)
            self._json(500, {"error": "The request could not be completed. See the server terminal for details."})

    def setup(self):
        super().setup()
        self.connection.settimeout(150)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8877)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        alternate_port = args.port + 1 if args.port < 65535 else 8877
        parser.exit(
            1,
            f"Could not start Chess Solver on http://127.0.0.1:{args.port}: {exc}.\n"
            f"Try another port: python3 server.py --port {alternate_port}\n",
        )
    server.daemon_threads = True
    print(f"Chess Solver is ready at http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Chess Solver.", flush=True)
    finally:
        server.server_close()
        ENGINE.close()
        COACH.close()
        REVIEW.close()


if __name__ == "__main__":
    main()
