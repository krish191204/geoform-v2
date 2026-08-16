"""Server settings loaded from environment variables (GEOFORM_*).

In v1 the server is a scaffold-only batch validator. The env surface is
deliberately minimal: a data directory for any cached files the batch
validator writes, and a timeout for ``POST /api/generate``.

Falls back to a tiny in-house ``.env`` loader if ``python-dotenv`` is not
installed, so we don't add a dependency for the sake of a single config file.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# Directory where this file lives (used to find a sibling .env file)
_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parent.parent


def _parse_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader. Sets vars on os.environ only if not already set."""
    if not path.exists() or not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        log.debug("dotenv read failed: %s", exc)
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # strip optional surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _load_dotenv() -> None:
    """Try python-dotenv if available; otherwise use our minimal parser."""
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(_REPO_ROOT / ".env")
        return
    except ImportError:
        pass
    _parse_dotenv(_REPO_ROOT / ".env")


_load_dotenv()


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return str(raw)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        log.warning("Invalid integer for %s=%r; using default %s", name, raw, default)
        return default


@dataclass(frozen=True)
class Settings:
    """Process-wide settings for the scaffold-only API."""

    host: str = field(default_factory=lambda: _env_str("GEOFORM_API_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("GEOFORM_API_PORT", 8765))
    data_dir: Path = field(
        default_factory=lambda: Path(_env_str("GEOFORM_DATA_DIR", str(_REPO_ROOT / "data")))
    )

    # Timeouts (ms)
    generate_timeout_ms: int = field(
        default_factory=lambda: _env_int("GEOFORM_GENERATE_TIMEOUT_MS", 180_000)
    )

    @property
    def generate_timeout_s(self) -> float:
        return self.generate_timeout_ms / 1000.0

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)


# Module-level cached singleton
_settings: Optional[Settings] = None


def get_settings() -> Settings:
    """Return the process-wide Settings instance (created on first call)."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings_for_tests(**overrides: object) -> Settings:
    """Recreate the settings singleton with overrides (used by tests)."""
    global _settings
    base = Settings()
    merged = {**base.__dict__, **overrides}
    _settings = Settings(**merged)
    return _settings
