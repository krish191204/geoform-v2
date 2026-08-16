"""FastAPI scaffold for the Geoform server.

In v1 the Python server is an optional batch validator used by CI to spot-check
Local TS physics. It exposes exactly two routes:

  - ``GET  /health``   liveness probe.
  - ``POST /api/generate``  delegates to :mod:`server.api.batch_validator`.

All other routes have been intentionally removed because Local TS owns the
interactive brain; this server only structurally validates a world-spec.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Dict, List

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError

from . import batch_validator, settings as settings_mod
from .errors import (
    APIError,
    error_response,
    validation_error,
    CODE_INTERNAL,
    CODE_NOT_FOUND,
    CODE_TIMEOUT,
    CODE_VALIDATION,
)
from .schemas import GenerateRequest
from .version import __version__

log = logging.getLogger("geoform.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = settings_mod.get_settings()
    s.ensure_dirs()
    log.info("Geoform API ready; data_dir=%s", s.data_dir)
    yield


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter()


async def _await_timeout(fut, *, timeout_s: float) -> Any:
    try:
        return await asyncio.wait_for(fut, timeout=timeout_s)
    except asyncio.TimeoutError as exc:
        raise APIError(
            CODE_TIMEOUT, "Request timed out", details={"timeout_s": timeout_s}, status=408
        ) from exc


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@router.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok", "version": __version__}


# ---------------------------------------------------------------------------
# Generate (delegates to the batch validator)
# ---------------------------------------------------------------------------


@router.post("/api/generate")
async def generate(req: GenerateRequest) -> Dict[str, Any]:
    s = settings_mod.get_settings()

    def _work() -> Dict[str, Any]:
        try:
            return batch_validator.validate_generate(req.model_dump())
        except APIError:
            raise
        except Exception as exc:
            log.exception("batch validator failed")
            raise APIError(
                CODE_INTERNAL,
                "batch_validator_failed",
                details={"error": str(exc)[:500]},
                status=500,
            ) from exc

    fut = asyncio.get_event_loop().run_in_executor(None, _work)
    return await _await_timeout(fut, timeout_s=s.generate_timeout_s)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    app = FastAPI(
        title="Geoform API",
        version=__version__,
        lifespan=lifespan,
    )
    app.include_router(router)

    @app.exception_handler(APIError)
    async def _api_handler(_request, exc: APIError):
        return error_response(exc.code, exc.message, details=exc.details or None, status=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(_request, exc: RequestValidationError):
        return validation_error("Request body failed validation", errors=exc.errors())

    @app.exception_handler(HTTPException)
    async def _http_exc_handler(_request, exc: HTTPException):
        code = CODE_INTERNAL
        if exc.status_code == 404:
            code = CODE_NOT_FOUND
        elif exc.status_code == 408:
            code = CODE_TIMEOUT
        elif exc.status_code == 400:
            code = CODE_VALIDATION
        return error_response(
            code,
            str(exc.detail) if exc.detail else "HTTP error",
            details=getattr(exc, "headers", None) or None,
            status=exc.status_code,
        )

    return app


# Module-level app for `uvicorn server.api.app:app`
app = create_app()


# ---------------------------------------------------------------------------
# Entry point (used by ``__main__.py``)
# ---------------------------------------------------------------------------


def main(argv: List[str] | None = None) -> int:
    """Console-script entry point: ``python -m server.api``."""
    try:
        import argparse

        import uvicorn
    except ImportError as exc:
        raise SystemExit(f"uvicorn is required to run the scaffold API: {exc}")

    p = argparse.ArgumentParser(
        prog="server.api",
        description="Geoform scaffold API server (batch validator only).",
    )
    p.add_argument("--host", default=None, help="Bind host (default: GEOFORM_API_HOST or 127.0.0.1)")
    p.add_argument("--port", type=int, default=None, help="Bind port (default: GEOFORM_API_PORT or 8765)")
    p.add_argument(
        "--data-dir",
        default=None,
        help="Data directory (default: GEOFORM_DATA_DIR or ./data)",
    )
    p.add_argument(
        "--log-level",
        default=os.getenv("GEOFORM_LOG_LEVEL", "info"),
        choices=["critical", "error", "warning", "info", "debug", "trace"],
    )
    args = p.parse_args(argv)

    if args.host is not None:
        os.environ["GEOFORM_API_HOST"] = args.host
    if args.port is not None:
        os.environ["GEOFORM_API_PORT"] = str(args.port)
    if args.data_dir is not None:
        os.environ["GEOFORM_DATA_DIR"] = args.data_dir

    s = settings_mod.reset_settings_for_tests()
    s.ensure_dirs()

    log.info("Starting Geoform API on %s:%s (data_dir=%s)", s.host, s.port, s.data_dir)

    uvicorn.run(
        "server.api.app:app",
        host=s.host,
        port=s.port,
        log_level=args.log_level,
        access_log=False,
    )
    return 0
