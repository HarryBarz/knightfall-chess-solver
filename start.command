#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if [ ! -x .venv/bin/python ]; then
  printf 'First run ./setup.sh in this folder.\n'
  exit 1
fi
exec .venv/bin/python server.py "$@"
