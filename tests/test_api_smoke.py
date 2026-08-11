"""Smoke tests for the Geoform API.

These tests use FastAPI's `TestClient` against an in-process app instance,
not a live server, so they're fast and isolated.  They cover the contract
envelope and basic shape guarantees described in `docs/contract.md`.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict

import numpy as np
import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def tmp_data_dir(tmp_path, monkeypatch) -> Path:
    """Per-test data dir, wired into GEOFORM_DATA_DIR before the app boots."""
    target = tmp_path / "geoform-data"
    target.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("GEOFORM_DATA_DIR", str(target))
    from server.api import settings as settings_mod

    settings_mod.reset_settings_for_tests(data_dir=target)
    settings_mod.get_settings().ensure_dirs()
    return target


@pytest.fixture()
def app_client(tmp_data_dir):
    """FastAPI TestClient bound to a freshly created app."""
    from server.api.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _small_generate_body(**overrides: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "name": "smoke",
        "width": 64,
        "height": 48,
        "seed": 12345,
        "num_plates": 8,
        "ocean_level": 1.0,
        "step": "full",
        "fade_borders": True,
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_health_returns_200_with_version(app_client: TestClient) -> None:
    """1. /health returns 200 with a non-empty version string."""
    r = app_client.get("/health")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body
    assert body["version"]


def test_generate_returns_valid_world_dict(app_client: TestClient) -> None:
    """2. /api/generate returns a 64x48 world with the expected shape."""
    r = app_client.post("/api/generate", json=_small_generate_body())
    assert r.status_code == 200, r.text
    w = r.json()
    assert w["schema_version"] == 1
    assert w["width"] == 64
    assert w["height"] == 48
    assert w["seed"] == 12345
    elev = np.asarray(w["layers"]["elevation"]["data"], dtype=np.float64)
    assert elev.shape == (48, 64)
    assert np.isfinite(elev).all()
    # Required layers per the contract
    for key in (
        "elevation",
        "plates",
        "ocean",
        "precipitation",
        "temperature",
        "biome",
        "humidity",
        "permeability",
        "watermap",
        "irrigation",
        "icecap",
    ):
        assert key in w["layers"], f"missing layer {key}"


def test_generate_rejects_out_of_bounds_width(app_client: TestClient) -> None:
    """3. width > MAX_WIDTH is rejected with a 400 validation envelope."""
    r = app_client.post("/api/generate", json=_small_generate_body(width=99999))
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["error"] == "validation"
    assert "message" in body


def test_serialize_deserialize_roundtrip_preserves_elevation(app_client: TestClient) -> None:
    """4. /api/serialize + /api/deserialize preserves the elevation array shape."""
    r = app_client.post("/api/generate", json=_small_generate_body())
    assert r.status_code == 200, r.text
    w = r.json()

    s = app_client.post("/api/serialize", json={"world": w})
    assert s.status_code == 200, s.text
    pb = s.json()["protobuf"]
    assert pb

    d = app_client.post("/api/deserialize", json={"protobuf": pb})
    assert d.status_code == 200, d.text
    w2 = d.json()["world"]

    before = np.asarray(w["layers"]["elevation"]["data"], dtype=np.float64)
    after = np.asarray(w2["layers"]["elevation"]["data"], dtype=np.float64)
    assert after.shape == before.shape
    assert before.tobytes() == after.tobytes()


def test_recompute_is_deterministic(app_client: TestClient) -> None:
    """5. Same world + same sculpt → identical protobuf bytes via /api/serialize."""
    r = app_client.post("/api/generate", json=_small_generate_body())
    assert r.status_code == 200, r.text
    w = r.json()

    # Two recomputes, no sculpt edits.
    r1 = app_client.post("/api/recompute", json={"world": w, "sculpt": []})
    r2 = app_client.post("/api/recompute", json={"world": w, "sculpt": []})
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text

    s1 = app_client.post("/api/serialize", json={"world": r1.json()})
    s2 = app_client.post("/api/serialize", json={"world": r2.json()})
    assert s1.status_code == 200 and s2.status_code == 200
    assert s1.json()["protobuf"] == s2.json()["protobuf"]


def test_settlements_are_deterministic_and_overridable(app_client: TestClient) -> None:
    """6. /api/settlements is deterministic and honors overrides."""
    r = app_client.post("/api/generate", json=_small_generate_body())
    assert r.status_code == 200, r.text
    w = r.json()

    rules = {
        "min_fresh_water": 0.2,
        "max_elevation": 1.8,
        "prefer_coastal": True,
        "arable_threshold": 0.35,
    }
    a = app_client.post("/api/settlements", json={"world": w, "rules": rules})
    b = app_client.post("/api/settlements", json={"world": w, "rules": rules})
    assert a.status_code == 200 and b.status_code == 200
    assert a.json() == b.json()

    cells = a.json()["cells"]
    assert cells, "expected at least one scored cell"
    # Every cell has the right keys and bounded suitability
    for key, cell in cells.items():
        assert "," in key
        assert set(cell.keys()) >= {"suitability", "rule", "reasons", "override"}
        assert 0.0 <= cell["suitability"] <= 1.0
        assert isinstance(cell["reasons"], list)

    # Override beats the rule: pick any cell, force it to "settlement"
    target = next(iter(cells))
    overridden = app_client.post(
        "/api/settlements",
        json={"world": w, "rules": rules, "overrides": {target: "settlement"}},
    )
    assert overridden.status_code == 200
    assert overridden.json()["cells"][target]["override"] == "settlement"
    assert overridden.json()["cells"][target]["rule"] == "settlement"


def test_worlds_crud_roundtrip(app_client: TestClient) -> None:
    """7. POST /api/worlds -> GET list -> GET by id -> DELETE -> 404."""
    r = app_client.post("/api/generate", json=_small_generate_body())
    assert r.status_code == 200, r.text
    w = r.json()

    # Save
    s = app_client.post("/api/worlds", json={"world": w})
    assert s.status_code in (200, 201), s.text
    wid = s.json()["id"]
    assert wid
    assert "saved_at" in s.json()

    # List
    lst = app_client.get("/api/worlds")
    assert lst.status_code == 200
    assert any(e["id"] == wid for e in lst.json()["worlds"])

    # Load
    ld = app_client.get(f"/api/worlds/{wid}")
    assert ld.status_code == 200
    elev = np.asarray(ld.json()["world"]["layers"]["elevation"]["data"], dtype=np.float64)
    orig = np.asarray(w["layers"]["elevation"]["data"], dtype=np.float64)
    assert elev.shape == orig.shape
    assert elev.tobytes() == orig.tobytes()

    # Delete
    rm = app_client.delete(f"/api/worlds/{wid}")
    assert rm.status_code == 200
    assert rm.json()["deleted"] is True

    # Gone
    gone = app_client.get(f"/api/worlds/{wid}")
    assert gone.status_code == 404


def test_migration_stamps_schema_version() -> None:
    """8. migrate({"schema_version": 0}) returns {"schema_version": 1, ...}."""
    from server.api.migrations import migrate, CURRENT_VERSION

    out = migrate({"schema_version": 0})
    assert out["schema_version"] == CURRENT_VERSION
    assert CURRENT_VERSION == 1

    # migrate is idempotent on already-current documents
    out2 = migrate({"schema_version": 1, "foo": "bar"})
    assert out2["schema_version"] == 1
    assert out2["foo"] == "bar"
