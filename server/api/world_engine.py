"""Thin wrapper around the vendored WorldEngine.

This module owns the conversion between the wire-level World JSON document
(defined in `docs/contract.md`) and the in-memory `World` class from
`worldengine.model.world`.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from worldengine import generation as we_generation
from worldengine import plates as we_plates
from worldengine import step as we_step
from worldengine.biome import biome_index_to_name, biome_name_to_index
from worldengine.model.world import GenerationParameters, Layer, Size, World

log = logging.getLogger(__name__)

# Default time-step distributions (must match docs/contract.md)
DEFAULT_TEMPS: List[float] = [0.874, 0.765, 0.594, 0.439, 0.366, 0.124]
DEFAULT_HUMIDS: List[float] = [0.941, 0.778, 0.507, 0.236, 0.073, 0.014, 0.002]

# Maps the contract's layer key to the attribute name on `World`.  Most map
# directly; we keep the mapping explicit so the on-wire schema can evolve
# independently of worldengine internals.
_LAYER_ATTRS: Dict[str, str] = {
    "elevation": "elevation",
    "plates": "plates",
    "ocean": "ocean",
    "sea_depth": "sea_depth",
    "precipitation": "precipitation",
    "temperature": "temperature",
    "humidity": "humidity",
    "permeability": "permeability",
    "watermap": "watermap",
    "irrigation": "irrigation",
    "lake_map": "lake_map",
    "river_map": "river_map",
    "biome": "biome",
    "icecap": "icecap",
}


# ---------------------------------------------------------------------------
# Public generation entry points
# ---------------------------------------------------------------------------


def _coerce_step(step: Any) -> Any:
    if isinstance(step, str):
        return we_step.Step.get_by_name(step)
    return step


def generate_world(
    name: str,
    width: int,
    height: int,
    seed: int,
    num_plates: int,
    ocean_level: float,
    step: Any,
    fade_borders: bool,
    temps: Sequence[float] = DEFAULT_TEMPS,
    humids: Sequence[float] = DEFAULT_HUMIDS,
    gamma_curve: float = 1.25,
    curve_offset: float = 0.2,
) -> World:
    """Run the full world-generation pipeline and return the live World.

    The global numpy RNG is seeded deterministically from `seed` so the
    elevation noise (and any other global-RNG consumers downstream) is
    reproducible.
    """
    from worldengine.plates import world_gen

    step_obj = _coerce_step(step)
    state = np.random.get_state()
    try:
        np.random.seed(int(seed))
        return world_gen(
            name=name,
            width=width,
            height=height,
            seed=seed,
            temps=list(temps),
            humids=list(humids),
            num_plates=num_plates,
            ocean_level=ocean_level,
            step=step_obj,
            gamma_curve=gamma_curve,
            curve_offset=curve_offset,
            fade_borders=fade_borders,
            verbose=False,
        )
    finally:
        np.random.set_state(state)


def recompute_from_world(
    world_obj: World,
    step: Any,
    *,
    sculpt_ops: Optional[Iterable[Any]] = None,
) -> World:
    """Re-run the full world generation pipeline and refresh derived layers.

    Per the contract, recompute regenerates elevation from the saved seed,
    applies any pending sculpt ops in order, then re-runs every downstream
    simulation.  This is deterministic and byte-stable: the same world + the
    same sculpt list always produces the same World.

    Implementation:
      1. Snapshot the global numpy RNG, seed it from `world_obj.seed`.
      2. Build a fresh World with `world_gen` (plates -> center -> noise ->
         border oceans -> ocean initialization -> downstream sims).
      3. If sculpt ops were supplied, apply them to the freshly built
         elevation, then re-derive the ocean layer and re-run the
         downstream sims (since both depend on elevation).
      4. Replace `world_obj.layers` with the freshly built layers and
         restore the global RNG.
    """
    # Pull the original generation parameters off the world.
    temps = list(getattr(world_obj, "temps", DEFAULT_TEMPS))
    humids = list(getattr(world_obj, "humids", DEFAULT_HUMIDS))
    gamma_curve = float(getattr(world_obj, "gamma_curve", 1.25))
    curve_offset = float(getattr(world_obj, "curve_offset", 0.2))
    n_plates = int(world_obj.generation_params.n_plates)
    ocean_level = float(world_obj.generation_params.ocean_level)
    fade_borders = bool(getattr(world_obj.generation_params, "fade_borders", True))
    step_obj = _coerce_step(step)

    state = np.random.get_state()
    try:
        np.random.seed(int(world_obj.seed))
        new_world = we_plates.world_gen(
            name=str(world_obj.name),
            width=int(world_obj.width),
            height=int(world_obj.height),
            seed=int(world_obj.seed),
            temps=temps,
            humids=humids,
            num_plates=n_plates,
            ocean_level=ocean_level,
            step=step_obj,
            gamma_curve=gamma_curve,
            curve_offset=curve_offset,
            fade_borders=fade_borders,
            verbose=False,
        )

        if sculpt_ops:
            apply_sculpt(new_world, sculpt_ops)
            # Sculpt modified elevation; the ocean layer is now stale, so
            # re-derive it.  Then re-run every downstream sim so they all
            # see the sculpted elevation.
            we_generation.initialize_ocean_and_thresholds(new_world)
            we_generation.generate_world(new_world, step_obj)
    finally:
        np.random.set_state(state)

    # Carry over the new world so the caller sees refreshed layers.  We mutate
    # the caller's world in-place by re-pointing its `layers` dict to the
    # newly built one, so any numpy buffers the caller still references
    # remain untouched.
    world_obj.layers = new_world.layers
    return world_obj


# ---------------------------------------------------------------------------
# Sculpt
# ---------------------------------------------------------------------------


def _make_gaussian_brush(radius: float) -> np.ndarray:
    """Return a (2r+1)x(2r+1) gaussian kernel normalized to peak=1."""
    r = max(1, int(np.ceil(radius)))
    size = 2 * r + 1
    ys, xs = np.mgrid[-r : r + 1, -r : r + 1]
    dist2 = (xs.astype(np.float64) ** 2) + (ys.astype(np.float64) ** 2)
    sigma = max(radius / 1.5, 0.5)
    kernel = np.exp(-dist2 / (2.0 * sigma * sigma))
    return kernel


def apply_sculpt(world_obj: World, sculpt_ops: Iterable[Any]) -> World:
    """Apply a list of sculpt ops to the elevation layer and return the World.

    A fresh copy of the elevation array is assigned, so the caller's numpy
    buffers are not mutated in place.  The caller is expected to follow up
    with `recompute_from_world` to refresh downstream layers.
    """
    if not sculpt_ops:
        return world_obj

    # Operate on a fresh array; worldengine layers are shared numpy buffers.
    elev = np.array(world_obj.layers["elevation"].data, copy=True)
    thresholds = list(world_obj.layers["elevation"].thresholds)

    for op in sculpt_ops:
        # Accept either a dict or a pydantic-style object with attribute access.
        if isinstance(op, Mapping):
            x = int(op.get("x", 0))
            y = int(op.get("y", 0))
            radius = float(op.get("radius", 1.0))
            delta = float(op.get("delta", 0.0))
            tool = str(op.get("tool", "raise"))
        else:
            x = int(getattr(op, "x", 0))
            y = int(getattr(op, "y", 0))
            radius = float(getattr(op, "radius", 1.0))
            delta = float(getattr(op, "delta", 0.0))
            tool = str(getattr(op, "tool", "raise"))

        h, w = elev.shape
        if x < 0 or y < 0 or x >= w or y >= h:
            # Out-of-bounds strokes are silently dropped; clients should clip.
            continue

        kernel = _make_gaussian_brush(radius)
        r = kernel.shape[0] // 2
        x0 = max(0, x - r)
        y0 = max(0, y - r)
        x1 = min(w, x + r + 1)
        y1 = min(h, y + r + 1)
        kx0 = x0 - (x - r)
        ky0 = y0 - (y - r)
        kx1 = kx0 + (x1 - x0)
        ky1 = ky0 + (y1 - y0)

        if tool == "raise":
            elev[y0:y1, x0:x1] += delta * kernel[ky0:ky1, kx0:kx1]
        elif tool == "lower":
            elev[y0:y1, x0:x1] -= delta * kernel[ky0:ky1, kx0:kx1]
        elif tool == "smooth":
            blurred = _box_blur(elev[y0:y1, x0:x1], max(1, int(radius)))
            elev[y0:y1, x0:x1] = (1.0 - delta) * elev[y0:y1, x0:x1] + delta * blurred
        elif tool == "flatten":
            target = float(elev[y, x])
            elev[y0:y1, x0:x1] = target + (elev[y0:y1, x0:x1] - target) * (1.0 - kernel[ky0:ky1, kx0:kx1])
        else:
            log.warning("Unknown sculpt tool %r; skipping", tool)

    world_obj.layers["elevation"] = type(world_obj.layers["elevation"])(elev, thresholds)
    return world_obj


def _box_blur(arr: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return arr
    pad = radius
    padded = np.pad(arr, pad, mode="edge")
    out = np.zeros_like(arr, dtype=np.float64)
    size = 2 * pad + 1
    for dy in range(size):
        for dx in range(size):
            out += padded[dy : dy + arr.shape[0], dx : dx + arr.shape[1]]
    out /= size * size
    return out


# ---------------------------------------------------------------------------
# World <-> JSON conversion
# ---------------------------------------------------------------------------


def _np_to_list(arr: Any) -> Any:
    """Convert a numpy array to a JSON-safe nested list with native Python types."""
    if isinstance(arr, np.ndarray):
        if arr.dtype == object:
            return arr.tolist()
        return arr.astype(float).tolist() if arr.dtype.kind == "f" else arr.astype(int).tolist()
    return arr


def _to_native(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return _np_to_list(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


def _layer_to_dict(layer: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"data": _to_native(layer.data)}
    thresholds = getattr(layer, "thresholds", None)
    if thresholds is not None:
        if isinstance(thresholds, dict):
            # watermap-style: name -> value
            payload["thresholds"] = {str(k): _to_native(v) for k, v in thresholds.items()}
        else:
            # list of (name, value) tuples
            payload["thresholds"] = [[_to_native(t[0]), _to_native(t[1])] for t in thresholds]
    quantiles = getattr(layer, "quantiles", None)
    if quantiles is not None:
        payload["quantiles"] = {str(k): float(v) for k, v in quantiles.items()}
    return payload


def to_dict(world: World) -> Dict[str, Any]:
    """Serialize a WorldEngine World into the contract's JSON document."""
    layers: Dict[str, Any] = {}
    for key in _LAYER_ATTRS:
        if key in world.layers:
            layers[key] = _layer_to_dict(world.layers[key])

    # The contract pins `biome` to an integer index; convert string form
    # back to int here.
    if "biome" in layers:
        try:
            layers["biome"]["data"] = [
                [biome_name_to_index(cell) for cell in row] for row in layers["biome"]["data"]
            ]
        except Exception:  # pragma: no cover - defensive
            log.exception("biome index conversion failed")

    step_name = world.generation_params.step.name
    if step_name not in ("full", "plates", "precipitations"):
        step_name = "full"

    generation_params = {
        "n_plates": int(world.generation_params.n_plates),
        "ocean_level": float(world.generation_params.ocean_level),
        "step": step_name,
        "fade_borders": True,
    }

    payload: Dict[str, Any] = {
        "schema_version": 1,
        "name": str(world.name),
        "width": int(world.width),
        "height": int(world.height),
        "seed": int(world.seed),
        "generation_params": generation_params,
        "temps": [float(t) for t in world.temps],
        "humids": [float(h) for h in world.humids],
        "gamma_curve": float(world.gamma_curve),
        "curve_offset": float(world.curve_offset),
        "layers": layers,
        "sculpt": [],
        "settlements": None,
    }
    return payload


def from_dict(d: Mapping[str, Any]) -> World:
    """Build a WorldEngine World from the contract JSON document."""
    width = int(d["width"])
    height = int(d["height"])
    seed = int(d["seed"])
    gen = d.get("generation_params") or {}
    step = we_step.Step.get_by_name(str(gen.get("step", "full")))
    gp = GenerationParameters(
        n_plates=int(gen.get("n_plates", 8)),
        ocean_level=float(gen.get("ocean_level", 1.0)),
        step=step,
    )
    w = World(
        name=str(d.get("name", "untitled")),
        size=Size(width, height),
        seed=seed,
        generation_params=gp,
        temps=[float(t) for t in d.get("temps", DEFAULT_TEMPS)],
        humids=[float(h) for h in d.get("humids", DEFAULT_HUMIDS)],
        gamma_curve=float(d.get("gamma_curve", 1.25)),
        curve_offset=float(d.get("curve_offset", 0.2)),
    )

    layers_in = d.get("layers") or {}
    for key, attr in _LAYER_ATTRS.items():
        if key not in layers_in:
            continue
        layer_data = layers_in[key].get("data")
        if layer_data is None:
            continue
        arr = np.asarray(layer_data)
        if key == "biome":
            # Stored as int indices; convert to string names for worldengine.
            try:
                arr = np.vectorize(biome_index_to_name, otypes=[object])(arr)
            except Exception:
                log.exception("biome string conversion failed; storing as-is")
            w.biome = arr  # type: ignore[assignment]
            continue

        thresholds_raw = layers_in[key].get("thresholds")
        quantiles_raw = layers_in[key].get("quantiles")

        if attr == "elevation" and thresholds_raw is not None:
            th = [(t[0], t[1]) for t in thresholds_raw]
            w.elevation = (arr, th)  # type: ignore[assignment]
        elif attr == "precipitation" and thresholds_raw is not None:
            th = [(t[0], t[1]) for t in thresholds_raw]
            w.precipitation = (arr, th)  # type: ignore[assignment]
        elif attr == "temperature" and thresholds_raw is not None:
            th = [(t[0], t[1]) for t in thresholds_raw]
            w.temperature = (arr, th)  # type: ignore[assignment]
        elif attr == "permeability" and thresholds_raw is not None:
            th = [(t[0], t[1]) for t in thresholds_raw]
            w.permeability = (arr, th)  # type: ignore[assignment]
        elif attr == "watermap" and thresholds_raw is not None:
            # Watermap thresholds are a dict by name; allow either form.
            if isinstance(thresholds_raw, dict):
                w.watermap = (arr, dict(thresholds_raw))  # type: ignore[assignment]
            else:
                w.watermap = (arr, {t[0]: t[1] for t in thresholds_raw})  # type: ignore[assignment]
        elif attr == "humidity":
            q = quantiles_raw or (
                {t[0]: t[1] for t in thresholds_raw} if isinstance(thresholds_raw, list) else None
            )
            if q is not None:
                w.humidity = (arr, q)  # type: ignore[assignment]
            else:
                w.humidity = (arr, {})  # type: ignore[assignment]
        else:
            setattr(w, attr, arr)

    return w


# ---------------------------------------------------------------------------
# Convenience for biome lookups
# ---------------------------------------------------------------------------


def biome_name_for_index(idx: int) -> Optional[str]:
    try:
        return biome_index_to_name(int(idx))
    except Exception:
        return None
