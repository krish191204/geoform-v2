"""Deterministic settlement-suitability computation.

This module is intentionally free of `worldengine` imports — it consumes the
World JSON dict directly via numpy arrays, so it remains cheap to unit-test
and easy to reason about.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

import numpy as np

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SettlementRules:
    min_fresh_water: float = 0.2
    max_elevation: float = 1.8
    prefer_coastal: bool = True
    arable_threshold: float = 0.35
    min_settlement_suitability: float = 0.5

    def as_dict(self) -> Dict[str, Any]:
        return {
            "min_fresh_water": self.min_fresh_water,
            "max_elevation": self.max_elevation,
            "prefer_coastal": self.prefer_coastal,
            "arable_threshold": self.arable_threshold,
            "min_settlement_suitability": self.min_settlement_suitability,
        }


def default_rules() -> SettlementRules:
    return SettlementRules()


# ---------------------------------------------------------------------------
# Cell result
# ---------------------------------------------------------------------------


@dataclass
class CellSuitability:
    suitability: float
    rule: Optional[str]
    reasons: List[str] = field(default_factory=list)
    override: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "suitability": float(self.suitability),
            "rule": self.rule,
            "reasons": list(self.reasons),
            "override": self.override,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _as_2d(data: Any) -> np.ndarray:
    if not isinstance(data, list):
        return np.asarray(data)
    rows = data
    width = len(rows[0]) if rows and isinstance(rows[0], list) else 0
    height = len(rows)
    out = np.zeros((height, width), dtype=np.float64)
    for y, row in enumerate(rows):
        for x, v in enumerate(row):
            out[y, x] = float(v)
    return out


def _ensure_float_layer(layers: Mapping[str, Any], key: str, height: int, width: int) -> np.ndarray:
    layer = layers.get(key)
    if not isinstance(layer, Mapping) or "data" not in layer:
        return np.zeros((height, width), dtype=np.float64)
    return _as_2d(layer["data"])


def _ensure_int_layer(layers: Mapping[str, Any], key: str, height: int, width: int) -> np.ndarray:
    layer = layers.get(key)
    if not isinstance(layer, Mapping) or "data" not in layer:
        return np.zeros((height, width), dtype=np.int8)
    arr = np.asarray(layer["data"])
    if arr.ndim != 2:
        return np.zeros((height, width), dtype=np.int8)
    return arr


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------


def compute_suitability(
    world: Mapping[str, Any],
    rules: Optional[SettlementRules] = None,
    overrides: Optional[Mapping[str, Optional[str]]] = None,
) -> Dict[str, CellSuitability]:
    """Compute per-cell settlement suitability.  Returns dict keyed by 'x,y'."""
    rules = rules or default_rules()
    overrides = overrides or {}

    width = int(world.get("width", 0))
    height = int(world.get("height", 0))
    if width <= 0 or height <= 0:
        return {}

    layers = world.get("layers") or {}
    elev = _ensure_float_layer(layers, "elevation", height, width)
    humidity = _ensure_float_layer(layers, "humidity", height, width)
    precip = _ensure_float_layer(layers, "precipitation", height, width)
    temp = _ensure_float_layer(layers, "temperature", height, width)
    ocean_raw = _ensure_int_layer(layers, "ocean", height, width)
    ocean = ocean_raw > 0

    # Coastal = adjacent to ocean in 4-neighborhood.
    coastal = np.zeros_like(ocean)
    if ocean.any():
        coastal[:-1, :] |= ocean[1:, :]
        coastal[1:, :] |= ocean[:-1, :]
        coastal[:, :-1] |= ocean[:, 1:]
        coastal[:, 1:] |= ocean[:, :-1]

    out: Dict[str, CellSuitability] = {}

    for y in range(height):
        for x in range(width):
            key = f"{x},{y}"
            override = overrides.get(key)
            if isinstance(override, str) and override not in ("settlement", "wilderness"):
                override = None

            if ocean[y, x]:
                # Ocean cells get suitability 0 with rule=wilderness.
                cell = CellSuitability(suitability=0.0, rule="wilderness", reasons=["ocean"], override=override)
                if override == "settlement":
                    cell.rule = "settlement"
                out[key] = cell
                continue

            elev_v = float(elev[y, x])
            hum_v = float(humidity[y, x])
            prec_v = float(precip[y, x])
            temp_v = float(temp[y, x])
            is_coastal = bool(coastal[y, x])

            reasons: List[str] = []
            score = 0.5  # base

            if hum_v < rules.min_fresh_water:
                score -= 0.30
                reasons.append("low_fresh_water")
            else:
                score += 0.15
                reasons.append("fresh_water")

            if elev_v > rules.max_elevation:
                score -= 0.25
                reasons.append("mountain")
            elif elev_v > rules.max_elevation * 0.6:
                reasons.append("hills")
            else:
                score += 0.10
                reasons.append("low_lying")

            if rules.prefer_coastal and is_coastal:
                score += 0.20
                reasons.append("coastal")

            # Arable: enough precipitation AND mid-range temperature
            if prec_v >= rules.arable_threshold and 0.3 <= temp_v <= 0.7:
                score += 0.15
                reasons.append("arable")

            # Clip to [0, 1]
            if score < 0.0:
                score = 0.0
            elif score > 1.0:
                score = 1.0

            # Decide rule: override > computed
            if override == "settlement":
                rule: Optional[str] = "settlement"
            elif override == "wilderness":
                rule = "wilderness"
            elif score >= rules.min_settlement_suitability:
                rule = "settlement"
            else:
                rule = "wilderness"

            out[key] = CellSuitability(
                suitability=float(score),
                rule=rule,
                reasons=reasons,
                override=override if isinstance(override, str) else None,
            )

    return out
