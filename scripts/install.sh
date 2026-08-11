#!/usr/bin/env bash
# scripts/install.sh — one-shot installer for Geoform.
# Idempotent: safe to re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[install] %s\n' "$*"; }

# 1. Create .venv if missing
if [[ ! -d ".venv" ]]; then
  log "Creating .venv"
  python3 -m venv .venv
else
  log ".venv already exists; skipping creation"
fi

# shellcheck disable=SC1091
source .venv/bin/activate

# 2. Upgrade pip/wheel/setuptools
log "Upgrading pip/wheel/setuptools"
python -m pip install --upgrade --quiet pip wheel setuptools

# 3. Install Python deps
log "Installing Python dependencies"
python -m pip install --quiet \
  "numpy<3" \
  "noise==1.2.2" \
  "protobuf" \
  "pypng" \
  "fastapi" \
  "uvicorn[standard]" \
  "httpx" \
  "pydantic" \
  "pytest" \
  "pytest-asyncio"

# 4. Install vendored WorldEngine (editable)
if [[ -d "vendor/worldengine" ]]; then
  log "Installing vendored WorldEngine (editable)"
  python -m pip install --quiet -e vendor/worldengine
else
  log "WARNING: vendor/worldengine not found; skipping editable install"
fi

# 5. npm install if node_modules missing
if [[ ! -d "node_modules" ]]; then
  log "Running npm install"
  npm install
else
  log "node_modules already present; skipping npm install"
fi

log "Done. next: run \`npm run dev\`"
