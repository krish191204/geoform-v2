"""Versioned World-document migrations.

A migration is `(from_version, to_version, fn(payload) -> payload)`.  They
are registered in order and walked from a document's `schema_version` up to
`CURRENT_VERSION`.  Adding a new on-disk version means appending a new
migration that knows how to translate from the previous one.
"""

from __future__ import annotations

import copy
import logging
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from .errors import APIError, CODE_VALIDATION

log = logging.getLogger(__name__)

CURRENT_VERSION = 1

# Each entry: (from, to, callable)
_MIGRATIONS: List[Tuple[int, int, Callable[[Dict[str, Any]], Dict[str, Any]]]] = [
    # v0 -> v1: nothing existed before v1, so just stamp the version.
    (0, 1, lambda p: {**p, "schema_version": 1}),
]


# ---------------------------------------------------------------------------
# Migration walker
# ---------------------------------------------------------------------------


def migrate(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Walk a payload forward through every migration up to CURRENT_VERSION."""
    data: Dict[str, Any] = dict(payload)
    version = int(data.get("schema_version", 0))
    if version > CURRENT_VERSION:
        raise APIError(
            CODE_VALIDATION,
            f"schema_version {version} is newer than supported ({CURRENT_VERSION})",
            details={"field": "schema_version", "value": version},
        )
    # Find a chain from current version up to CURRENT_VERSION
    while version < CURRENT_VERSION:
        fn = _find_migration(version)
        if fn is None:
            raise APIError(
                CODE_VALIDATION,
                f"No migration from schema_version {version}",
                details={"field": "schema_version", "value": version},
            )
        data = fn(data)
        version = int(data.get("schema_version", version))
    # Always stamp the final version for safety.
    data["schema_version"] = CURRENT_VERSION
    return data


def _find_migration(from_version: int) -> Optional[Callable[[Dict[str, Any]], Dict[str, Any]]]:
    for f, _t, fn in _MIGRATIONS:
        if f == from_version:
            return fn
    return None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


_REQUIRED_TOP_KEYS = {
    "name",
    "width",
    "height",
    "seed",
    "generation_params",
    "layers",
}


def validate(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Validate a payload against the current schema.  Returns the (migrated) doc.

    Raises `APIError("validation", ...)` on the first problem found.
    """
    doc = copy.deepcopy(dict(payload))
    doc = migrate(doc)

    missing = [k for k in _REQUIRED_TOP_KEYS if k not in doc]
    if missing:
        raise APIError(
            CODE_VALIDATION,
            f"Missing required fields: {', '.join(missing)}",
            details={"missing": missing},
        )

    try:
        width = int(doc["width"])
        height = int(doc["height"])
    except (TypeError, ValueError) as exc:
        raise APIError(CODE_VALIDATION, "width/height must be integers", details={"error": str(exc)})

    if width <= 0 or height <= 0:
        raise APIError(CODE_VALIDATION, "width/height must be positive", details={"width": width, "height": height})

    try:
        seed = int(doc["seed"])
    except (TypeError, ValueError) as exc:
        raise APIError(CODE_VALIDATION, "seed must be an integer", details={"error": str(exc)})

    gen = doc.get("generation_params") or {}
    if not isinstance(gen, Mapping):
        raise APIError(CODE_VALIDATION, "generation_params must be an object", details={"type": type(gen).__name__})

    if "n_plates" in gen:
        try:
            int(gen["n_plates"])
        except (TypeError, ValueError):
            raise APIError(CODE_VALIDATION, "generation_params.n_plates must be an integer")

    layers = doc.get("layers") or {}
    if not isinstance(layers, Mapping):
        raise APIError(CODE_VALIDATION, "layers must be an object")

    # Verify elevation is shaped width x height if present
    elev = layers.get("elevation")
    if isinstance(elev, Mapping) and "data" in elev:
        data = elev["data"]
        if not isinstance(data, list) or not all(isinstance(row, list) for row in data):
            raise APIError(CODE_VALIDATION, "layers.elevation.data must be a list of lists")
        if data and len(data[0]) != width:
            raise APIError(
                CODE_VALIDATION,
                "layers.elevation.data width does not match world width",
                details={"expected": width, "actual": len(data[0]) if data else 0},
            )
        if len(data) != height:
            raise APIError(
                CODE_VALIDATION,
                "layers.elevation.data height does not match world height",
                details={"expected": height, "actual": len(data)},
            )

    return doc
