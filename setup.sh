#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
.venv/bin/python scripts/install_stockfish.py
printf '\nReady. Run ./start.command and open http://127.0.0.1:8877\n'
