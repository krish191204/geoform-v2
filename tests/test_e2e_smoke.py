"""End-to-end smoke test: the whole product loop, once, against a live server.

`test_api_integration.py` pins each endpoint against docs/contract.md. This
file does the complementary job: it walks the journey a user actually takes —
generate a world, score settlements, sculpt a mountain, recompute, re-score,
save, reload, delete — and asserts the state stays coherent across the hops.
If this test fails, the product is broken even if every endpoint passes in
isolation.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict

import httpx
import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

# Deliberately small: this test is about the journey, not about terrain quality.
WIDTH = 96
HEIGHT = 64
SEED = 7

RULES = {
    "min_fresh_water": 0.2,
    "max_elevation": 1.8,
    "prefer_coastal": True,
    "arable_threshold": 0.35,
}


def _elevation(world: Dict[str, Any]) -> np.ndarray:
    return np.asarray(world["layers"]["elevation"]["data"], dtype=np.float64)


def test_full_world_journey(client: httpx.Client) -> None:
    """generate -> settle -> sculpt -> recompute -> settle -> save -> load -> delete."""
    # 1. Generate.
    generated = client.post(
        "/api/generate",
        json={
            "name": "smoke-journey",
            "width": WIDTH,
            "height": HEIGHT,
            "seed": SEED,
            "num_plates": 8,
        },
    )
    assert generated.status_code == 200, generated.text
    world = generated.json()
    assert world["schema_version"] == 1
    assert _elevation(world).shape == (HEIGHT, WIDTH)

    # 2. Score settlements on the pristine world.
    scored = client.post("/api/settlements", json={"world": world, "rules": RULES})
    assert scored.status_code == 200, scored.text
    before_cells = scored.json()["cells"]
    assert before_cells, "no settlement cells scored"

    # 3. Sculpt: raise the deepest cell into a mountain.
    elevation_before = _elevation(world)
    y, x = np.unravel_index(int(np.argmin(elevation_before)), elevation_before.shape)
    y, x = int(y), int(x)
    delta = float(elevation_before.max() - elevation_before.min()) * 2.0 + 5.0
    sculpt = [{"x": x, "y": y, "radius": 5, "delta": delta, "tool": "raise"}]

    edited = copy.deepcopy(world)
    edited["sculpt"] = sculpt

    # 4. Recompute so the climate/biome layers catch up with the new terrain.
    recomputed = client.post("/api/recompute", json={"world": edited, "sculpt": sculpt})
    assert recomputed.status_code == 200, recomputed.text
    world2 = recomputed.json()
    world2 = world2["world"] if "world" in world2 else world2

    elevation_after = _elevation(world2)
    assert elevation_after[y, x] > elevation_before[y, x], "sculpt did not raise terrain"
    assert world2["width"] == WIDTH and world2["height"] == HEIGHT

    # 5. Re-score: the edit must be visible to the settlement pass.
    rescored = client.post("/api/settlements", json={"world": world2, "rules": RULES})
    assert rescored.status_code == 200, rescored.text
    after_cells = rescored.json()["cells"]
    assert after_cells, "no settlement cells after recompute"
    assert after_cells != before_cells, (
        "raising a mountain changed nothing in settlement scoring — "
        "the settlement pass is probably not reading the recomputed layers"
    )

    # 6. Save the edited world.
    saved = client.post("/api/worlds", json={"world": world2})
    assert saved.status_code in (200, 201), saved.text
    world_id = saved.json()["id"]

    # 7. Reload it and confirm the sculpted terrain survived the round-trip.
    loaded = client.get(f"/api/worlds/{world_id}")
    assert loaded.status_code == 200, loaded.text
    assert _elevation(loaded.json()["world"]).tobytes() == elevation_after.tobytes(), (
        "reloaded world does not match what was saved"
    )

    # 8. Clean up.
    deleted = client.delete(f"/api/worlds/{world_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted"] is True


def test_built_spa_is_servable() -> None:
    """`npm run build` output is a static bundle any host can serve.

    Skipped when dist/ hasn't been built — CI builds the frontend in the `web`
    job, not the `api` job.
    """
    index = REPO_ROOT / "dist" / "index.html"
    if not index.exists():
        pytest.skip("dist/ not built (run `npm run build`)")

    html = index.read_text(encoding="utf-8")
    assert "<div id=\"app\"></div>" in html or "id=\"app\"" in html, (
        "built index.html is missing the SPA mount point"
    )

    # Every local asset the bundle references must actually exist on disk.
    referenced = [
        part.split('"')[0]
        for marker in ('src="', 'href="')
        for part in html.split(marker)[1:]
        if part.startswith("/") or part.startswith("./")
    ]
    for ref in referenced:
        asset = REPO_ROOT / "dist" / ref.lstrip("/.")
        assert asset.exists(), f"dist/index.html references missing asset {ref}"
