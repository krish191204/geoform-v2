#!/usr/bin/env bash
# scripts/smoke.sh — end-to-end smoke test against `python -m server.api`.
#
# Boots the API on a private port with a tmp data dir, exercises the core
# endpoints (/health, /api/generate, /api/serialize, /api/deserialize,
# /api/settlements), and tears the server down. Exits 0 on success, non-zero
# with a clear message on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- pick a python interpreter ----------------------------------------------------

if [[ -x ".venv/bin/python" ]]; then
  PYTHON=".venv/bin/python"
else
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
  else
    PYTHON="$(command -v python)"
  fi
fi

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "[smoke] FATAL: no python interpreter available (looked for .venv/bin/python, python3, python)" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "[smoke] FATAL: curl is required for this script" >&2
  exit 1
fi

# --- tmp data dir so we never touch the real data/ --------------------------------

SMOKE_DATA_DIR="$(mktemp -d -t geoform-smoke-XXXXXX)"
SMOKE_LOG="$(mktemp -t geoform-smoke-log-XXXXXX.log)"
GEN_BODY_FILE="$(mktemp -t geoform-gen-XXXXXX.json)"
SMOKE_PORT="${GEOFORM_SMOKE_PORT:-8766}"
BASE_URL="http://127.0.0.1:${SMOKE_PORT}"
SERVER_PID=""

cleanup() {
  local rc=$?
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    # Give it a moment, then SIGKILL if still alive.
    for _ in 1 2 3 4 5; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill -9 "${SERVER_PID}" 2>/dev/null || true
    fi
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${SMOKE_DATA_DIR}" "${SMOKE_LOG}" "${GEN_BODY_FILE}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT INT TERM

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }

# --- boot the server in the background -------------------------------------------

log "Booting server on ${BASE_URL} (data dir: ${SMOKE_DATA_DIR})"

export PYTHONPATH="${REPO_ROOT}"
export PYTHONUNBUFFERED=1
export GEOFORM_DATA_DIR="${SMOKE_DATA_DIR}"
export GEOFORM_API_HOST="127.0.0.1"
export GEOFORM_API_PORT="${SMOKE_PORT}"

"$PYTHON" -m server.api --host 127.0.0.1 --port "${SMOKE_PORT}" \
  >"${SMOKE_LOG}" 2>&1 &
SERVER_PID=$!

log "Server pid=${SERVER_PID}, waiting up to 10s for /health"

DEADLINE=$((SECONDS + 10))
START_WAIT=$SECONDS
while (( SECONDS < DEADLINE )); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    log "--- server log ---"
    cat "${SMOKE_LOG}" >&2 || true
    fail "server exited during startup"
  fi
  if curl -fsS -o /dev/null "${BASE_URL}/health" 2>/dev/null; then
    log "/health answered 200 after $((SECONDS - START_WAIT))s"
    break
  fi
  sleep 0.2
done

if ! curl -fsS -o /dev/null "${BASE_URL}/health" 2>/dev/null; then
  log "--- server log ---"
  cat "${SMOKE_LOG}" >&2 || true
  fail "server did not answer /health within 10s"
fi

# --- /api/generate ---------------------------------------------------------------
# Write the request body to a temp file to avoid ARG_MAX limits when the response
# (which gets piped downstream) is large.

log "POST /api/generate (64x48, seed=1)"
cat >"${GEN_BODY_FILE}" <<'JSON'
{"name":"smoke","width":64,"height":48,"seed":1,"num_plates":8,"ocean_level":1.0,"step":"full","fade_borders":true}
JSON

curl -fsS -X POST "${BASE_URL}/api/generate" \
  -H 'content-type: application/json' \
  --data-binary "@${GEN_BODY_FILE}" \
  >"${GEN_BODY_FILE}.out" \
  || { log "--- server log ---"; cat "${SMOKE_LOG}" >&2 || true; fail "/api/generate failed"; }

"${PYTHON}" - "${GEN_BODY_FILE}.out" <<'PY' \
  || { log "--- server log ---"; cat "${SMOKE_LOG}" >&2 || true; fail "/api/generate response invalid"; }
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    w = json.loads(f.read())
assert w.get('schema_version') == 1, f"schema_version must be 1, got {w.get('schema_version')!r}"
assert w.get('width') == 64, f"width must be 64, got {w.get('width')!r}"
assert w.get('height') == 48, f"height must be 48, got {w.get('height')!r}"
elev = w['layers']['elevation']['data']
rows = len(elev)
cols = len(elev[0]) if rows else 0
assert (rows, cols) == (48, 64), f"elevation shape must be (48, 64), got ({rows}, {cols})"
print(f"generate ok: shape=({rows},{cols}), schema_version={w['schema_version']}")
PY

# --- /api/serialize then /api/deserialize -----------------------------------------
# Use stdin for the large body to keep the world JSON out of argv.

log "POST /api/serialize + /api/deserialize (round-trip)"
ROUND_OUT="$(
  "${PYTHON}" - "${GEN_BODY_FILE}.out" "${BASE_URL}" <<'PY' \
    || { log "--- server log ---"; cat "${SMOKE_LOG}" >&2 || true; fail "round-trip failed"; }
import json
import subprocess
import sys

world_path, base_url = sys.argv[1], sys.argv[2]
with open(world_path, "r", encoding="utf-8") as f:
    w = json.loads(f.read())

# /api/serialize — pipe the body via stdin to keep argv small.
ser = subprocess.run(
    [
        "curl", "-fsS", "-X", "POST",
        f"{base_url}/api/serialize",
        "-H", "content-type: application/json",
        "--data-binary", "@-",
    ],
    input=json.dumps({"world": w}).encode("utf-8"),
    check=True,
    capture_output=True,
)
pb = json.loads(ser.stdout)["protobuf"]
assert isinstance(pb, str) and pb, "serialize must return a non-empty base64 string"

# /api/deserialize — same stdin trick.
des = subprocess.run(
    [
        "curl", "-fsS", "-X", "POST",
        f"{base_url}/api/deserialize",
        "-H", "content-type: application/json",
        "--data-binary", "@-",
    ],
    input=json.dumps({"protobuf": pb}).encode("utf-8"),
    check=True,
    capture_output=True,
)
w2 = json.loads(des.stdout)["world"]

before_rows = len(w["layers"]["elevation"]["data"])
before_cols = len(w["layers"]["elevation"]["data"][0])
after_rows = len(w2["layers"]["elevation"]["data"])
after_cols = len(w2["layers"]["elevation"]["data"][0])
assert (before_rows, before_cols) == (after_rows, after_cols), (
    f"elevation shape changed across round-trip: ({before_rows},{before_cols}) -> ({after_rows},{after_cols})"
)
print(f"round-trip ok: shape=({after_rows},{after_cols})")
PY
)"
log "${ROUND_OUT}"

# --- /api/settlements ------------------------------------------------------------

log "POST /api/settlements"
SETTLE_OUT="$(
  "${PYTHON}" - "${GEN_BODY_FILE}.out" "${BASE_URL}" <<'PY' \
    || { log "--- server log ---"; cat "${SMOKE_LOG}" >&2 || true; fail "/api/settlements failed"; }
import json
import subprocess
import sys

world_path, base_url = sys.argv[1], sys.argv[2]
with open(world_path, "r", encoding="utf-8") as f:
    w = json.loads(f.read())

rules = {
    "min_fresh_water": 0.2,
    "max_elevation": 1.8,
    "prefer_coastal": True,
    "arable_threshold": 0.35,
}
req = {"world": w, "rules": rules}

r = subprocess.run(
    [
        "curl", "-fsS", "-X", "POST",
        f"{base_url}/api/settlements",
        "-H", "content-type: application/json",
        "--data-binary", "@-",
    ],
    input=json.dumps(req).encode("utf-8"),
    check=True,
    capture_output=True,
)
body = json.loads(r.stdout)
cells = body.get("cells")
assert isinstance(cells, dict), f"cells must be a dict, got {type(cells).__name__}"
assert len(cells) >= 1, f"expected at least one settlement cell, got {len(cells)}"
print(f"settlements ok: {len(cells)} cell(s) scored")
PY
)"
log "${SETTLE_OUT}"

log "All smoke checks passed."
