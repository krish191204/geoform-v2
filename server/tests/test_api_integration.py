"""End-to-end integration tests against a live Geoform API server.

Every test here talks HTTP to a real `python -m server.api` subprocess (see
conftest.py). The assertions track docs/contract.md — if a test fails, either
the server drifted from the contract or the contract changed and this file
needs to follow it.
"""

from __future__ import annotations

import base64
import copy
from typing import TYPE_CHECKING, Any, Dict

import httpx
import numpy as np
import pytest

if TYPE_CHECKING:  # annotations only — avoids importing the conftest module at runtime
    from conftest import ServerHandle

# Small enough to keep the suite fast, large enough to exercise real terrain.
WIDTH = 128
HEIGHT = 96
SEED = 42

# Asserted boot budget for /health (see test_health_boots_fast).
BOOT_BUDGET_S = 5.0


# --------------------------------------------------------------------------- helpers


def _elevation(world: Dict[str, Any]) -> np.ndarray:
    """Elevation layer as a float64 array of shape (height, width)."""
    return np.asarray(world["layers"]["elevation"]["data"], dtype=np.float64)


def _raw_layer(world: Dict[str, Any], name: str) -> Any:
    """Raw (unconverted) layer rows — biome may be ints or strings, so no dtype."""
    return world["layers"][name]["data"]


def _generate(client: httpx.Client, **overrides: Any) -> httpx.Response:
    payload: Dict[str, Any] = {
        "name": "test-world",
        "width": WIDTH,
        "height": HEIGHT,
        "seed": SEED,
        "num_plates": 8,
    }
    payload.update(overrides)
    return client.post("/api/generate", json=payload)


def _serialize(client: httpx.Client, world: Dict[str, Any]) -> str:
    response = client.post("/api/serialize", json={"world": world})
    assert response.status_code == 200, response.text
    protobuf = response.json()["protobuf"]
    assert isinstance(protobuf, str) and protobuf, "expected a non-empty base64 string"
    return protobuf


def _recompute(
    client: httpx.Client,
    world: Dict[str, Any],
    sculpt: list | None = None,
) -> Dict[str, Any]:
    """POST /api/recompute.

    Sculpt ops are sent both top-level and on the world document: the contract
    carries them on the world (docs/contract.md "sculpt"), while the server's
    RecomputeRequest also accepts a top-level list. Sending both keeps this
    test honest against either reading.
    """
    body = {"world": world, "sculpt": sculpt or []}
    response = client.post("/api/recompute", json=body)
    assert response.status_code == 200, response.text
    payload = response.json()
    # The contract returns "the same world document"; accept it either bare or
    # wrapped in {"world": ...}.
    return payload["world"] if "world" in payload else payload


@pytest.fixture(scope="session")
def base_world(client: httpx.Client) -> Dict[str, Any]:
    """One generated world (128x96, seed 42) shared by the read-only tests.

    Tests that mutate it must deepcopy first.
    """
    response = _generate(client)
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- tests


def test_health_boots_fast(server: ServerHandle, client: httpx.Client) -> None:
    """1. Server comes up quickly and /health reports a version."""
    assert server.boot_seconds < BOOT_BUDGET_S, (
        f"server took {server.boot_seconds:.2f}s to answer /health "
        f"(budget {BOOT_BUDGET_S}s)"
    )

    response = client.get("/health")
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body, f"/health must report a version, got {body!r}"
    assert body["version"], "version must not be empty"


def test_generate_returns_world_with_elevation_grid(base_world: Dict[str, Any]) -> None:
    """2. /api/generate returns a v1 World with a correctly shaped elevation layer."""
    assert base_world["schema_version"] == 1
    assert base_world["width"] == WIDTH
    assert base_world["height"] == HEIGHT
    assert base_world["seed"] == SEED

    elevation = _elevation(base_world)
    assert elevation.shape == (HEIGHT, WIDTH), (
        f"elevation must be rows x cols = (height, width) = ({HEIGHT}, {WIDTH}), "
        f"got {elevation.shape}"
    )
    assert np.isfinite(elevation).all(), "elevation contains NaN/inf"
    assert elevation.min() < elevation.max(), "elevation is flat — generation did nothing"


def test_serialize_deserialize_roundtrip_preserves_elevation(
    client: httpx.Client, base_world: Dict[str, Any]
) -> None:
    """3. serialize -> deserialize is lossless for the elevation array.

    World.proto stores elevation as `double`, so this is byte-exact, not
    approximate.
    """
    protobuf = _serialize(client, base_world)
    assert len(base64.b64decode(protobuf)) > 0, "protobuf payload decoded to nothing"

    response = client.post("/api/deserialize", json={"protobuf": protobuf})
    assert response.status_code == 200, response.text
    restored = response.json()["world"]

    assert restored["width"] == base_world["width"]
    assert restored["height"] == base_world["height"]

    before = _elevation(base_world)
    after = _elevation(restored)
    assert after.shape == before.shape
    assert before.tobytes() == after.tobytes(), "elevation changed across the round-trip"


def test_recompute_without_edits_is_byte_stable(
    client: httpx.Client, base_world: Dict[str, Any]
) -> None:
    """4. Recompute with no sculpt edits is deterministic and elevation-preserving."""
    world = copy.deepcopy(base_world)
    world["sculpt"] = []

    once = _recompute(client, world)
    twice = _recompute(client, copy.deepcopy(once))

    # The contract's explicit requirement: feeding a recomputed world back into
    # /api/recompute with no edits must serialize to identical bytes.
    first = _serialize(client, once)
    second = _serialize(client, twice)
    assert first == second, "repeated recompute produced different protobuf bytes"

    # An edit-free recompute regenerates elevation from the saved seed, so it
    # must reproduce what /api/generate produced ("recompute replaces the
    # derived layers"; elevation is not one of them).
    assert _elevation(once).tobytes() == _elevation(base_world).tobytes(), (
        "recompute with no edits changed the elevation layer"
    )


def test_recompute_with_sculpt_raise_updates_derived_layers(
    client: httpx.Client, base_world: Dict[str, Any]
) -> None:
    """5. A sculpt 'raise' lifts the cell and refreshes the derived ocean/biome layers."""
    world = copy.deepcopy(base_world)
    elevation_before = _elevation(world)
    ocean_before = copy.deepcopy(_raw_layer(world, "ocean"))
    biome_before = copy.deepcopy(_raw_layer(world, "biome"))

    # Raise the deepest ocean cell far above sea level so the flip to land is
    # unambiguous and must cascade into ocean + biome.
    y, x = np.unravel_index(int(np.argmin(elevation_before)), elevation_before.shape)
    y, x = int(y), int(x)
    span = float(elevation_before.max() - elevation_before.min())
    delta = span * 2.0 + 5.0

    world["sculpt"] = [{"x": x, "y": y, "radius": 6, "delta": delta, "tool": "raise"}]
    updated = _recompute(client, world, sculpt=world["sculpt"])

    elevation_after = _elevation(updated)
    assert elevation_after.shape == elevation_before.shape
    assert elevation_after[y, x] > elevation_before[y, x], (
        f"sculpt raise at ({x},{y}) did not increase elevation: "
        f"{elevation_before[y, x]} -> {elevation_after[y, x]}"
    )

    assert _raw_layer(updated, "ocean") != ocean_before, (
        "ocean layer was not refreshed after raising the deepest cell above sea level"
    )
    assert _raw_layer(updated, "biome") != biome_before, (
        "biome layer was not refreshed after a sculpt edit"
    )


def test_settlements_are_deterministic_and_overridable(
    client: httpx.Client, base_world: Dict[str, Any]
) -> None:
    """6. /api/settlements returns scored cells, is deterministic, and honours overrides."""
    rules = {
        "min_fresh_water": 0.2,
        "max_elevation": 1.8,
        "prefer_coastal": True,
        "arable_threshold": 0.35,
    }
    request = {"world": base_world, "rules": rules}

    first = client.post("/api/settlements", json=request)
    assert first.status_code == 200, first.text
    cells = first.json()["cells"]
    assert cells, "expected at least one scored cell"

    for key, cell in cells.items():
        assert "," in key, f"cell keys must be 'x,y', got {key!r}"
        for field in ("suitability", "rule", "reasons", "override"):
            assert field in cell, f"cell {key} missing {field!r}: {cell!r}"
        assert 0.0 <= cell["suitability"] <= 1.0, f"suitability out of range at {key}"
        assert isinstance(cell["reasons"], list)

    # Deterministic: identical inputs, identical output.
    second = client.post("/api/settlements", json=request)
    assert second.status_code == 200, second.text
    assert second.json()["cells"] == cells, "settlement scoring is not deterministic"

    # Override wins: pick a cell the rules did NOT mark as a settlement.
    target = next(
        (k for k, c in cells.items() if c.get("rule") != "settlement"),
        next(iter(cells)),
    )
    overridden = client.post(
        "/api/settlements",
        json={**request, "overrides": {target: "settlement"}},
    )
    assert overridden.status_code == 200, overridden.text
    cell = overridden.json()["cells"][target]
    assert cell["override"] == "settlement", (
        f"override was not applied to {target}: {cell!r}"
    )


def test_world_store_crud_lifecycle(
    client: httpx.Client, base_world: Dict[str, Any]
) -> None:
    """7. Save -> list -> load -> delete round-trip through the durable store."""
    saved = client.post("/api/worlds", json={"world": base_world})
    assert saved.status_code in (200, 201), saved.text
    saved_body = saved.json()
    world_id = saved_body["id"]
    assert world_id
    assert "saved_at" in saved_body

    listed = client.get("/api/worlds")
    assert listed.status_code == 200, listed.text
    entries = listed.json()["worlds"]
    match = next((e for e in entries if e["id"] == world_id), None)
    assert match is not None, f"{world_id} missing from {entries!r}"
    assert match["width"] == WIDTH
    assert match["height"] == HEIGHT

    loaded = client.get(f"/api/worlds/{world_id}")
    assert loaded.status_code == 200, loaded.text
    loaded_world = loaded.json()["world"]
    assert _elevation(loaded_world).tobytes() == _elevation(base_world).tobytes(), (
        "loaded world's elevation differs from what was saved"
    )

    deleted = client.delete(f"/api/worlds/{world_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted"] is True

    gone = client.get(f"/api/worlds/{world_id}")
    assert gone.status_code >= 400, f"deleted world still loads: {gone.text}"
    # The contract pins the error *code*; it does not pin the HTTP status for
    # this route, so assert on the envelope rather than on 404 specifically.
    assert gone.json()["error"] == "not_found", gone.text

    remaining = client.get("/api/worlds").json()["worlds"]
    assert all(e["id"] != world_id for e in remaining), "deleted world still listed"


def test_width_alignment_is_not_required_but_bounds_are_enforced(
    client: httpx.Client,
) -> None:
    """8. Unaligned sizes are fine; out-of-bounds sizes are a 400 validation error."""
    unaligned = _generate(client, width=99, height=64, name="unaligned")
    assert unaligned.status_code == 200, (
        f"width=99 must be accepted (no alignment requirement): {unaligned.text}"
    )
    assert _elevation(unaligned.json()).shape == (64, 99)

    too_wide = _generate(client, width=99999, name="too-wide")
    assert too_wide.status_code == 400, (
        f"width=99999 exceeds the documented max of 2048: {too_wide.status_code}"
    )
    body = too_wide.json()
    assert body["error"] == "validation", f"expected the validation envelope, got {body!r}"
    assert "message" in body
