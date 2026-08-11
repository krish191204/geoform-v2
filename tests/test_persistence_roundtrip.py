"""Persistence round-trip and CRUD lifecycle tests.

These tests hit the live `python -m server.api` subprocess started by the
`server` fixture (see conftest.py). They focus on the durable world store and
the protobuf serialize/deserialize pipeline, complementing the broader
contract checks in test_api_integration.py.
"""

from __future__ import annotations

import base64
from typing import TYPE_CHECKING, Any, Dict

import numpy as np
import pytest

if TYPE_CHECKING:  # annotations only — avoids importing the conftest module at runtime
    from conftest import ServerHandle

# A small world keeps these tests fast while still exercising the storage path.
WIDTH = 64
HEIGHT = 48
SEED = 7


def _elevation(world: Dict[str, Any]) -> np.ndarray:
    """Elevation layer as a float64 array of shape (height, width)."""
    return np.asarray(world["layers"]["elevation"]["data"], dtype=np.float64)


def _generate(client, **overrides: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "name": "persistence-roundtrip",
        "width": WIDTH,
        "height": HEIGHT,
        "seed": SEED,
        "num_plates": 8,
        "ocean_level": 1.0,
        "step": "full",
        "fade_borders": True,
    }
    payload.update(overrides)
    response = client.post("/api/generate", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_serialize_deserialize_elevation_is_byte_equal(client) -> None:
    """serialize -> deserialize preserves the elevation numpy bytes exactly."""
    world = _generate(client)

    ser = client.post("/api/serialize", json={"world": world})
    assert ser.status_code == 200, ser.text
    protobuf = ser.json()["protobuf"]
    assert isinstance(protobuf, str) and protobuf, "expected a non-empty base64 string"
    assert len(base64.b64decode(protobuf)) > 0, "protobuf payload decoded to nothing"

    des = client.post("/api/deserialize", json={"protobuf": protobuf})
    assert des.status_code == 200, des.text
    restored = des.json()["world"]

    before = _elevation(world)
    after = _elevation(restored)
    assert after.shape == before.shape, (
        f"elevation shape changed across round-trip: {before.shape} -> {after.shape}"
    )
    # World.proto stores elevation as `double`, so this is byte-exact.
    assert before.tobytes() == after.tobytes(), (
        "elevation bytes differ after serialize -> deserialize round-trip"
    )


def test_worlds_crud_full_lifecycle(client) -> None:
    """Save -> list -> load-by-id -> delete covers the full CRUD path."""
    world = _generate(client, name="crud-lifecycle")

    # 1. Save
    saved = client.post("/api/worlds", json={"world": world})
    assert saved.status_code in (200, 201), saved.text
    saved_body = saved.json()
    world_id = saved_body["id"]
    assert world_id, f"saved world must carry an id, got {saved_body!r}"
    assert "saved_at" in saved_body, "save response must include saved_at"

    try:
        # 2. List — the saved world must appear with the expected dimensions.
        listed = client.get("/api/worlds")
        assert listed.status_code == 200, listed.text
        entries = listed.json()["worlds"]
        match = next((e for e in entries if e["id"] == world_id), None)
        assert match is not None, f"{world_id} missing from listing {entries!r}"
        assert match["width"] == WIDTH
        assert match["height"] == HEIGHT
        assert match["seed"] == SEED

        # 3. Load by id — elevation bytes must equal what was saved.
        loaded = client.get(f"/api/worlds/{world_id}")
        assert loaded.status_code == 200, loaded.text
        loaded_world = loaded.json()["world"]
        before = _elevation(world)
        after = _elevation(loaded_world)
        assert after.shape == before.shape
        assert after.tobytes() == before.tobytes(), (
            "loaded world's elevation bytes differ from what was saved"
        )

        # 3b. Loading an unknown id is a 404 — confirm the path is real, not a stub.
        missing = client.get(f"/api/worlds/{world_id}-does-not-exist")
        assert missing.status_code == 404, (
            f"GET on unknown id must be 404, got {missing.status_code}: {missing.text}"
        )

    finally:
        # 4. Delete — always run, even if the assertions above fire.
        deleted = client.delete(f"/api/worlds/{world_id}")
        assert deleted.status_code == 200, deleted.text
        assert deleted.json().get("deleted") is True, (
            f"delete response must confirm deletion, got {deleted.json()!r}"
        )

        # 5. Gone — load returns 404 and list no longer contains the id.
        gone = client.get(f"/api/worlds/{world_id}")
        assert gone.status_code == 404, (
            f"deleted world still loads: {gone.text}"
        )
        remaining = client.get("/api/worlds").json()["worlds"]
        assert all(e["id"] != world_id for e in remaining), (
            f"deleted world still listed: {[e['id'] for e in remaining]}"
        )

        # Idempotent: deleting again is safe. The server returns either 404
        # or a 400 with {"error": "not_found"} envelope — both are valid
        # "already gone" responses per docs/contract.md.
        redelete = client.delete(f"/api/worlds/{world_id}")
        if redelete.status_code == 400:
            body = redelete.json()
            assert body.get("error") == "not_found", (
                f"second delete 400 must carry the 'not_found' error code, got {body!r}"
            )
        else:
            assert redelete.status_code == 404, (
                f"second delete must be 404 or 400/not_found, got {redelete.status_code}: {redelete.text}"
            )
