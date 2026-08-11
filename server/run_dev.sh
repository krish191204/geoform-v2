#!/usr/bin/env bash
# server/run_dev.sh — activate venv (if present) and run the API server.
# Useful inside Docker and for ops.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f ".venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

exec python -m server.api --host 0.0.0.0 --port 8765
