"""Pydantic request/response schemas for the Geoform scaffold API.

In v1 the only endpoint that surfaces a Pydantic model is ``POST /api/generate``.
The server is not the live interactive brain (Local TS is), so we only need
shape validation for the world-spec handed to the batch validator.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, confloat, conint

# ---------------------------------------------------------------------------
# Bounds — enforced by GenerateRequest below. Kept as module constants so
# the batch validator and tests can reference the same numbers.
# ---------------------------------------------------------------------------

MIN_WIDTH = 32
MAX_WIDTH = 2048
MIN_HEIGHT = 32
MAX_HEIGHT = 2048
MIN_PLATES = 1
MAX_PLATES = 100
MIN_SEED = 0
MAX_SEED = 65535


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------


class GenerateRequest(BaseModel):
    """Minimal world-spec; Local TS owns generation, the server only validates."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(
        None, min_length=1, max_length=200, description="Human-readable world name (optional)"
    )
    width: conint(ge=MIN_WIDTH, le=MAX_WIDTH) = Field(256, description="Map width in cells")
    height: conint(ge=MIN_HEIGHT, le=MAX_HEIGHT) = Field(192, description="Map height in cells")
    seed: conint(ge=MIN_SEED, le=MAX_SEED) = Field(..., description="Deterministic seed")
    num_plates: conint(ge=MIN_PLATES, le=MAX_PLATES) = Field(8, description="Number of tectonic plates")
    ocean_level: confloat(ge=0.0, le=2.0) = Field(1.0, description="Sea level threshold")
