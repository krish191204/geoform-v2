#!/usr/bin/env bash
# scripts/dev.sh — convenience wrapper around `npm run dev`.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec npm run dev
