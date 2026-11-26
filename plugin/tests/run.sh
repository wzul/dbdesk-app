#!/bin/sh
# Run the DB Desk backend/agent test suite.
# Uses the Hermes runtime when present; otherwise any Python with fastapi +
# cryptography (e.g. CI: PYTHON=python ./tests/run.sh).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERMES_ROOT=${HERMES_ROOT:-/usr/local/lib/hermes-agent}

PYTHON=${PYTHON:-}
if [ -z "$PYTHON" ] && [ -x "$HERMES_ROOT/venv/bin/python" ]; then
  PYTHON="$HERMES_ROOT/venv/bin/python"
fi
if [ -z "$PYTHON" ]; then
  PYTHON=$(command -v python3 || true)
fi
if [ -z "$PYTHON" ]; then
  echo "No Python found; set PYTHON=/path/to/python (needs fastapi + cryptography)" >&2
  exit 1
fi
if [ -d "$HERMES_ROOT" ]; then
  PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}"
  export PYTHONPATH
fi

# These tests cover the psql-CLI fallback. With psycopg installed the code takes
# the native path instead and the mocks never fire, so pin the driver off; export
# DBDESK_PG_DRIVER yourself to run them against a real driver instead.
DBDESK_PG_DRIVER=${DBDESK_PG_DRIVER:-none}
export DBDESK_PG_DRIVER
exec "$PYTHON" -m unittest discover -s "$HERE" -p 'test_*.py' -v
