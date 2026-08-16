"""Optional batch validator for the Local TS physics pipeline.

The Geoform server is a scaffold-only batch validator used by CI to spot-check
Local TS physics output. It exposes a single endpoint, `POST /api/generate`,
which delegates to :func:`validate_generate` in this module.

The validator is intentionally a stub in v1: Local TS is the source of truth
for all interactive work, and the Python side only needs to confirm the
shape of a generation request. v2 (Phase 4 of the rebuild plan) will replace
the stub body with an actual cross-check that invokes the Local TS pipeline
via Pyodide (browser-side) or a subprocess call into the Node/TS toolchain,
then diffs the generated measurements against the Local TS output.
"""

from __future__ import annotations

from typing import Any, Dict, List


def validate_generate(req: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a small world-spec without driving the full pipeline.

    The returned shape is contract-stable and consumed by CI:
        - ``ok``: bool, true iff the spec passed structural checks.
        - ``issues``: list of human-readable issue strings (empty when ok).
        - ``measurements``: dict of derived numeric facts about the spec.

    v1 is a structural stub: it only echoes back the basic dimensions of the
    request so CI has something to assert against. It does NOT generate a
    world; Local TS owns generation.

    TODO(rebuild-v2): wire to the Local TS pipeline. The real implementation
    should (a) ship the same spec to Local TS via Pyodide or subprocess,
    (b) capture the resulting measurements, and (c) return them under
    ``measurements`` alongside a pass/fail summary under ``issues``.
    """
    issues: List[str] = []

    width = req.get("width")
    height = req.get("height")
    seed = req.get("seed")
    num_plates = req.get("num_plates")
    ocean_level = req.get("ocean_level")

    # Structural checks only. Numeric-range bounds are enforced by the
    # ``GenerateRequest`` Pydantic model in ``schemas.py`` before reaching
    # this function, so we only sanity-check presence and types here.
    if not isinstance(width, int) or width <= 0:
        issues.append("width must be a positive integer")
    if not isinstance(height, int) or height <= 0:
        issues.append("height must be a positive integer")
    if not isinstance(seed, int) or seed < 0:
        issues.append("seed must be a non-negative integer")
    if not isinstance(num_plates, int) or num_plates <= 0:
        issues.append("num_plates must be a positive integer")
    if not isinstance(ocean_level, (int, float)) or ocean_level < 0:
        issues.append("ocean_level must be a non-negative number")

    return {
        "ok": not issues,
        "issues": issues,
        "measurements": {
            "width": width,
            "height": height,
            "seed": seed,
            "num_plates": num_plates,
            "ocean_level": ocean_level,
        },
    }
