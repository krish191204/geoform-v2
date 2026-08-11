"""Standard error envelope and helpers for the Geoform API."""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)

# Canonical error codes
CODE_VALIDATION = "validation"
CODE_NOT_FOUND = "not_found"
CODE_TIMEOUT = "timeout"
CODE_CONFLICT = "conflict"
CODE_INTERNAL = "internal"

VALID_CODES = {CODE_VALIDATION, CODE_NOT_FOUND, CODE_TIMEOUT, CODE_CONFLICT, CODE_INTERNAL}


class APIError(Exception):
    """Raised inside handlers and converted to a JSON error envelope."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Optional[Dict[str, Any]] = None,
        status: int = 400,
    ) -> None:
        if code not in VALID_CODES:
            raise ValueError(f"Unknown error code: {code!r}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        self.status = status


def _envelope(code: str, message: str, details: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"error": code, "message": message}
    if details:
        body["details"] = details
    return body


def error_response(
    code: str,
    message: str,
    details: Optional[Dict[str, Any]] = None,
    status: int = 400,
) -> JSONResponse:
    """Build a JSONResponse with the standard error envelope."""
    if code not in VALID_CODES:
        raise ValueError(f"Unknown error code: {code!r}")
    return JSONResponse(status_code=status, content=_envelope(code, message, details))


def validation_error(message: str, field: Optional[str] = None, **extra: Any) -> JSONResponse:
    details: Dict[str, Any] = dict(extra)
    if field is not None:
        details["field"] = field
    return error_response(CODE_VALIDATION, message, details=details or None, status=400)


def not_found_error(message: str = "Not found", **extra: Any) -> JSONResponse:
    return error_response(CODE_NOT_FOUND, message, details=extra or None, status=404)


def timeout_error(message: str = "Request timed out", **extra: Any) -> JSONResponse:
    return error_response(CODE_TIMEOUT, message, details=extra or None, status=408)


def conflict_error(message: str, **extra: Any) -> JSONResponse:
    return error_response(CODE_CONFLICT, message, details=extra or None, status=409)


def internal_error(message: str = "Internal server error", **extra: Any) -> JSONResponse:
    return error_response(CODE_INTERNAL, message, details=extra or None, status=500)


async def api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """FastAPI exception handler for APIError instances."""
    assert isinstance(exc, APIError)
    return error_response(exc.code, exc.message, details=exc.details or None, status=exc.status)
