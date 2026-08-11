"""Disk-backed World store.

Layout: `<data_dir>/worlds/<id>.json` (the versioned World document) plus a
sidecar `<id>.meta.json` with `id`, `name`, `width`, `height`, `seed`,
`saved_at`.  Writes are atomic (write-to-tmp + rename) so a crashed server
can't leave half-written files behind.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import string
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .errors import APIError, CODE_CONFLICT, CODE_NOT_FOUND, CODE_VALIDATION, CODE_TIMEOUT
from .migrations import migrate

log = logging.getLogger(__name__)

_ID_ALPHABET = string.ascii_lowercase + string.digits


def _slugify(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:48] or "world"


def _new_id(name: str) -> str:
    suffix = "".join(secrets.choice(_ID_ALPHABET) for _ in range(6))
    return f"{_slugify(name)}-{suffix}"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Save / Load
# ---------------------------------------------------------------------------


def save(
    world_dict: Dict[str, Any],
    data_dir: Path,
    world_id: Optional[str] = None,
) -> Tuple[str, str]:
    """Persist a world dict; return (id, saved_at ISO string)."""
    if not isinstance(world_dict, dict):
        raise APIError(CODE_VALIDATION, "world must be an object")

    data_dir = Path(data_dir)
    worlds_dir = data_dir / "worlds"
    worlds_dir.mkdir(parents=True, exist_ok=True)

    # Ensure the world document carries a version stamp.
    payload = migrate(dict(world_dict))
    name = str(payload.get("name", "untitled"))
    width = int(payload.get("width", 0))
    height = int(payload.get("height", 0))
    seed = int(payload.get("seed", 0))

    target_id = world_id or _new_id(name)
    body_path = worlds_dir / f"{target_id}.json"
    if body_path.exists():
        raise APIError(CODE_CONFLICT, f"World with id {target_id!r} already exists", details={"id": target_id})

    saved_at = _iso_now()
    body_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    _atomic_write(body_path, body_bytes)

    meta = {
        "id": target_id,
        "name": name,
        "width": width,
        "height": height,
        "seed": seed,
        "saved_at": saved_at,
    }
    meta_path = worlds_dir / f"{target_id}.meta.json"
    _atomic_write(meta_path, json.dumps(meta, indent=2).encode("utf-8"))

    return target_id, saved_at


def load(world_id: str, data_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Load a world; returns (world_dict, meta_dict)."""
    data_dir = Path(data_dir)
    body_path = data_dir / "worlds" / f"{world_id}.json"
    meta_path = data_dir / "worlds" / f"{world_id}.meta.json"
    if not body_path.exists():
        raise APIError(CODE_NOT_FOUND, f"World {world_id!r} not found", details={"id": world_id}, status=404)

    with body_path.open("r", encoding="utf-8") as f:
        body = json.load(f)
    body = migrate(body)

    if meta_path.exists():
        with meta_path.open("r", encoding="utf-8") as f:
            meta = json.load(f)
    else:
        meta = {
            "id": world_id,
            "name": str(body.get("name", "untitled")),
            "width": int(body.get("width", 0)),
            "height": int(body.get("height", 0)),
            "seed": int(body.get("seed", 0)),
            "saved_at": _iso_now(),
        }
    return body, meta


def list_worlds(data_dir: Path) -> List[Dict[str, Any]]:
    data_dir = Path(data_dir)
    worlds_dir = data_dir / "worlds"
    if not worlds_dir.exists():
        return []
    out: List[Dict[str, Any]] = []
    for meta_path in sorted(worlds_dir.glob("*.meta.json")):
        try:
            with meta_path.open("r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Skipping bad meta file %s: %s", meta_path, exc)
            continue
        if all(k in meta for k in ("id", "name", "width", "height", "seed", "saved_at")):
            out.append(
                {
                    "id": meta["id"],
                    "name": meta["name"],
                    "width": int(meta["width"]),
                    "height": int(meta["height"]),
                    "seed": int(meta["seed"]),
                    "saved_at": meta["saved_at"],
                }
            )
    out.sort(key=lambda m: m.get("saved_at", ""))
    return out


def delete(world_id: str, data_dir: Path) -> bool:
    data_dir = Path(data_dir)
    body_path = data_dir / "worlds" / f"{world_id}.json"
    meta_path = data_dir / "worlds" / f"{world_id}.meta.json"
    if not body_path.exists() and not meta_path.exists():
        return False
    for p in (body_path, meta_path):
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    return True


def export_world(world_id: str, data_dir: Path) -> bytes:
    """Return the raw .json bytes for export."""
    data_dir = Path(data_dir)
    body_path = data_dir / "worlds" / f"{world_id}.json"
    if not body_path.exists():
        raise APIError(CODE_NOT_FOUND, f"World {world_id!r} not found", details={"id": world_id}, status=404)
    return body_path.read_bytes()


def import_world(payload_bytes: bytes, data_dir: Path) -> str:
    """Import a previously-exported world JSON payload.  Returns its id."""
    try:
        doc = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise APIError(CODE_VALIDATION, "Invalid world JSON", details={"error": str(exc)})
    if not isinstance(doc, dict):
        raise APIError(CODE_VALIDATION, "World payload must be a JSON object")
    target_id, _ = save(doc, data_dir=data_dir)
    return target_id
