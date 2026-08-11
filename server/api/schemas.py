"""Pydantic request/response schemas matching docs/contract.md.

Pydantic is used for shape validation only; per-cell numeric content is NOT
validated because it would be prohibitively slow on 2048x2048 maps.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, conint, confloat

# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------

MIN_WIDTH = 32
MAX_WIDTH = 2048
MIN_HEIGHT = 32
MAX_HEIGHT = 2048
MIN_PLATES = 1
MAX_PLATES = 100
MIN_SEED = 0
MAX_SEED = 65535

# Set a generous outer-shape cap so a malicious caller can't ship a 5GB payload.
# 2048*2048 = 4_194_304 cells per matrix; allow up to 8 such layers in a request.
_MAX_CELLS_PER_MATRIX = MAX_WIDTH * MAX_HEIGHT + 1


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------

StepName = Literal["full", "plates", "precipitations"]


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=200, description="Human-readable world name")
    width: conint(ge=MIN_WIDTH, le=MAX_WIDTH) = Field(256, description="Map width in cells")
    height: conint(ge=MIN_HEIGHT, le=MAX_HEIGHT) = Field(192, description="Map height in cells")
    seed: conint(ge=MIN_SEED, le=MAX_SEED) = Field(..., description="Deterministic seed")
    num_plates: conint(ge=MIN_PLATES, le=MAX_PLATES) = Field(8, description="Number of tectonic plates")
    ocean_level: confloat(ge=0.0, le=2.0) = Field(1.0, description="Sea level threshold")
    step: StepName = Field("full", description="Pipeline depth")
    fade_borders: bool = Field(True, description="Force ocean at map borders")
    temps: List[float] = Field(
        default_factory=lambda: [0.874, 0.765, 0.594, 0.439, 0.366, 0.124],
        description="Temperature quantiles",
    )
    humids: List[float] = Field(
        default_factory=lambda: [0.941, 0.778, 0.507, 0.236, 0.073, 0.014, 0.002],
        description="Humidity quantiles",
    )
    gamma_curve: confloat(gt=0.0) = Field(1.25, description="Gamma curve for elevation")
    curve_offset: confloat(ge=0.0) = Field(0.2, description="Curve offset for elevation")


# ---------------------------------------------------------------------------
# Recompute
# ---------------------------------------------------------------------------


class SculptOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: conint(ge=0) = Field(..., description="Brush center X")
    y: conint(ge=0) = Field(..., description="Brush center Y")
    radius: confloat(gt=0.0) = Field(..., description="Brush radius in cells")
    delta: float = Field(..., description="Signed elevation delta (peak value)")
    tool: Literal["raise", "lower", "smooth", "flatten"] = Field("raise", description="Brush tool")


class RecomputeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    world: Dict[str, Any] = Field(..., description="World JSON document")
    sculpt: List[SculptOp] = Field(default_factory=list, description="Sculpt ops to apply first")


# ---------------------------------------------------------------------------
# Protobuf
# ---------------------------------------------------------------------------


class SerializeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    world: Dict[str, Any] = Field(..., description="World JSON document")


class SerializeResponse(BaseModel):
    protobuf: str = Field(..., description="Base64-encoded protobuf bytes")


class DeserializeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protobuf: str = Field(..., description="Base64-encoded protobuf bytes")


# ---------------------------------------------------------------------------
# Settlements
# ---------------------------------------------------------------------------


class SettlementRulesModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min_fresh_water: confloat(ge=0.0, le=1.0) = Field(0.2, description="Min humidity for fresh water")
    max_elevation: confloat(ge=0.0) = Field(1.8, description="Elevation above which cells are penalized")
    prefer_coastal: bool = Field(True, description="Bonus for cells near ocean")
    arable_threshold: confloat(ge=0.0, le=1.0) = Field(0.35, description="Min precipitation for arable")
    min_settlement_suitability: confloat(ge=0.0, le=1.0) = Field(
        0.5, description="Threshold above which a cell is a settlement"
    )


class SettlementsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    world: Dict[str, Any] = Field(..., description="World JSON document")
    rules: Optional[SettlementRulesModel] = None
    overrides: Dict[str, Optional[Literal["settlement", "wilderness"]]] = Field(
        default_factory=dict, description="Per-cell rule overrides keyed by 'x,y'"
    )


class CellSuitability(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suitability: confloat(ge=0.0, le=1.0) = Field(..., description="Suitability score 0..1")
    rule: Optional[Literal["settlement", "wilderness"]] = Field(None, description="Computed rule")
    reasons: List[str] = Field(default_factory=list, description="Human-readable reasons")
    override: Optional[Literal["settlement", "wilderness"]] = Field(None, description="User override if any")


class SettlementsResponse(BaseModel):
    cells: Dict[str, CellSuitability] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# World persistence
# ---------------------------------------------------------------------------


class SaveWorldRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    world: Optional[Dict[str, Any]] = None
    protobuf: Optional[str] = None


class SaveWorldResponse(BaseModel):
    id: str
    world: Dict[str, Any]
    saved_at: str


class WorldSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    width: int
    height: int
    seed: int
    saved_at: str


class ListWorldsResponse(BaseModel):
    worlds: List[WorldSummary]


class LoadWorldResponse(BaseModel):
    id: str
    world: Dict[str, Any]


class DeleteWorldResponse(BaseModel):
    deleted: bool


# ---------------------------------------------------------------------------
# World shape (lightweight inner type for /api/generate response).
# The full World JSON document is dict-shaped; we type it as Dict[str, Any]
# at the API surface but expose this helper for documentation / type hints.
# ---------------------------------------------------------------------------


class LayerPayload(BaseModel):
    """Outer shape of a single layer in the world JSON.

    We don't validate the nested list contents; only the outer shape.
    """

    model_config = ConfigDict(extra="allow")

    data: Union[List[List[float]], List[List[int]]] = Field(..., max_length=_MAX_CELLS_PER_MATRIX)
    thresholds: Optional[List[List[Optional[float]]]] = None
    quantiles: Optional[Dict[str, float]] = None


WorldDict = Dict[str, Any]
