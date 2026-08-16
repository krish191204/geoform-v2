"""FastAPI router exposing the plain-English → DirectorPlan translator.

Wraps :mod:`server.api.director_interpret` (a regex/rules fallback with an
optional Gemini backend) behind ``POST /api/interpret``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict

from fastapi import APIRouter

from .director_interpret import interpret_director
from .errors import APIError, CODE_INTERNAL, CODE_VALIDATION
from .schemas import InterpretRequest

log = logging.getLogger("geoform.api.interpret")

router = APIRouter()


@router.post("/api/interpret")
async def interpret(req: InterpretRequest) -> Dict[str, Any]:
    """Translate a free-form director prompt into structured actions."""

    prompt = (req.prompt or "").strip()
    if not prompt:
        raise APIError(
            CODE_VALIDATION,
            "prompt must be a non-empty string",
            details={"field": "prompt"},
        )

    def _work() -> Dict[str, Any]:
        try:
            return interpret_director(prompt, req.context or {})
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("director interpret failed")
            raise APIError(
                CODE_INTERNAL,
                "director_interpret_failed",
                details={"error": str(exc)[:500]},
                status=500,
            ) from exc

    fut = asyncio.get_event_loop().run_in_executor(None, _work)
    return await fut
