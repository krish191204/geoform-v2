"""Geoform scaffold API: optional batch validator for Local TS physics.

Exposes a tiny surface area in v1 — just the FastAPI ``app`` object and the
package version. The server is not the interactive brain of the app; Local
TS owns worldbuilding. See :mod:`server.api.app` and
:mod:`server.api.batch_validator` for the actual implementation.
"""

from __future__ import annotations

from .version import __version__

__all__ = ["__version__"]
