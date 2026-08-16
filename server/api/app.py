"""FastAPI app exposing the Geoform World generation / save API."""

from __future__ import annotations

import asyncio
import base64
import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import APIRouter, FastAPI, HTTPException, Path
from fastapi.exceptions import RequestValidationError

from . import persistence, settings as settings_mod, world_engine
from .errors import (
    APIError,
    error_response,
    validation_error,
    CODE_INTERNAL,
    CODE_NOT_FOUND,
    CODE_TIMEOUT,
    CODE_VALIDATION,
)
from .interpret import router as interpret_router
from .migrations import migrate, validate
from .schemas import (
    DeserializeRequest,
    GenerateRequest,
    InterpretRequest,
    RecomputeRequest,
    SaveWorldRequest,
    SerializeRequest,
    SettlementRulesModel,
    SettlementsRequest,
)
from .settlements import compute_suitability, default_rules
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


def _run_in_executor(coro_factory, *, timeout_s: float) -> Any:
    """Run a sync callable on the default executor, honoring a timeout.

    Returns the result.  On timeout, raises APIError("timeout", ...).
    """
    loop = asyncio.get_event_loop()
    fut = loop.run_in_executor(None, coro_factory)
    try:
        return loop.run_until_complete(asyncio.wait_for(fut, timeout=timeout_s))
    except asyncio.TimeoutError as exc:
        raise APIError(CODE_TIMEOUT, "Request timed out", details={"timeout_s": timeout_s}, status=408) from exc


async def _await_timeout(fut, *, timeout_s: float) -> Any:
    try:
        return await asyncio.wait_for(fut, timeout=timeout_s)
    except asyncio.TimeoutError as exc:
        raise APIError(CODE_TIMEOUT, "Request timed out", details={"timeout_s": timeout_s}, status=408) from exc


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@router.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok", "version": __version__}


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------


@router.post("/api/generate")
async def generate(req: GenerateRequest) -> Dict[str, Any]:
    s = settings_mod.get_settings()
    if req.width > s.max_width or req.height > s.max_height:
        raise APIError(
            CODE_VALIDATION,
            f"width/height exceed max ({s.max_width}x{s.max_height})",
            details={"max_width": s.max_width, "max_height": s.max_height},
        )

    def _work() -> Dict[str, Any]:
        try:
            w = world_engine.generate_world(
                name=req.name,
                width=req.width,
                height=req.height,
                seed=req.seed,
                num_plates=req.num_plates,
                ocean_level=req.ocean_level,
                step=req.step,
                fade_borders=req.fade_borders,
                temps=req.temps,
                humids=req.humids,
                gamma_curve=req.gamma_curve,
                curve_offset=req.curve_offset,
            )
        except Exception as exc:
            log.exception("worldengine generate failed")
            raise APIError(
                CODE_INTERNAL,
                "worldengine_generate_failed",
                details={"stage": "generate", "error": str(exc)[:500]},
                status=500,
            ) from exc
        return world_engine.to_dict(w)

    fut = asyncio.get_event_loop().run_in_executor(None, _work)
    return await _await_timeout(fut, timeout_s=s.generate_timeout_s)


# ---------------------------------------------------------------------------
# Recompute
# ---------------------------------------------------------------------------


@router.post("/api/recompute")
async def recompute(req: RecomputeRequest) -> Dict[str, Any]:
    s = settings_mod.get_settings()

    def _work() -> Dict[str, Any]:
        try:
            payload = migrate(dict(req.world))
            w = world_engine.from_dict(payload)
            step = (payload.get("generation_params") or {}).get("step", "full")
            world_engine.recompute_from_world(w, step, sculpt_ops=req.sculpt)
        except APIError:
            raise
        except Exception as exc:
            log.exception("worldengine recompute failed")
            raise APIError(
                CODE_INTERNAL,
                "worldengine_recompute_failed",
                details={"stage": "recompute", "error": str(exc)[:500]},
                status=500,
            ) from exc
        return world_engine.to_dict(w)

    fut = asyncio.get_event_loop().run_in_executor(None, _work)
    return await _await_timeout(fut, timeout_s=s.recompute_timeout_s)


# ---------------------------------------------------------------------------
# Protobuf
# ---------------------------------------------------------------------------


@router.post("/api/serialize")
async def serialize(req: SerializeRequest) -> Dict[str, str]:
    def _work() -> str:
        try:
            w = world_engine.from_dict(migrate(dict(req.world)))
            raw = w.protobuf_serialize()
        except APIError:
            raise
        except Exception as exc:
            log.exception("serialize failed")
            raise APIError(
                CODE_INTERNAL,
                "worldengine_serialize_failed",
                details={"stage": "serialize", "error": str(exc)[:500]},
                status=500,
            ) from exc
        return base64.b64encode(raw).decode("ascii")

    return {"protobuf": await asyncio.get_event_loop().run_in_executor(None, _work)}


@router.post("/api/deserialize")
async def deserialize(req: DeserializeRequest) -> Dict[str, Any]:
    from worldengine.model.world import World

    def _work() -> Dict[str, Any]:
        try:
            raw = base64.b64decode(req.protobuf.encode("ascii"), validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise APIError(CODE_VALIDATION, "Invalid base64 payload", details={"error": str(exc)})
        try:
            w = World.protobuf_unserialize(raw)
        except Exception as exc:
            log.exception("deserialize failed")
            raise APIError(
                CODE_INTERNAL,
                "worldengine_deserialize_failed",
                details={"stage": "deserialize", "error": str(exc)[:500]},
                status=500,
            ) from exc
        return world_engine.to_dict(w)

    return {"world": await asyncio.get_event_loop().run_in_executor(None, _work)}


# ---------------------------------------------------------------------------
# Settlements
# ---------------------------------------------------------------------------


@router.post("/api/settlements")
async def settlements(req: SettlementsRequest) -> Dict[str, Any]:
    s = settings_mod.get_settings()

    def _work() -> Dict[str, Dict[str, Any]]:
        rules = (
            default_rules()
            if req.rules is None
            else _rules_from_pydantic(req.rules)
        )
        try:
            cells = compute_suitability(req.world, rules=rules, overrides=req.overrides)
        except Exception as exc:
            log.exception("settlements failed")
            raise APIError(
                CODE_INTERNAL,
                "settlements_failed",
                details={"error": str(exc)[:500]},
                status=500,
            ) from exc
        return {k: v.to_dict() for k, v in cells.items()}

    fut = asyncio.get_event_loop().run_in_executor(None, _work)
    return {"cells": await _await_timeout(fut, timeout_s=s.recompute_timeout_s)}


def _rules_from_pydantic(model: SettlementRulesModel) -> "world_engine._SettlementRules":  # type: ignore[name-defined]
    # Import here to avoid a circular import in the type stub above.
    from .settlements import SettlementRules

    return SettlementRules(
        min_fresh_water=model.min_fresh_water,
        max_elevation=model.max_elevation,
        prefer_coastal=model.prefer_coastal,
        arable_threshold=model.arable_threshold,
        min_settlement_suitability=model.min_settlement_suitability,
    )


# ---------------------------------------------------------------------------
# Worlds CRUD
# ---------------------------------------------------------------------------


@router.post("/api/worlds")
async def save_world(req: SaveWorldRequest) -> Dict[str, Any]:
    s = settings_mod.get_settings()
    if req.world is None and req.protobuf is None:
        raise APIError(CODE_VALIDATION, "Either 'world' or 'protobuf' must be provided")

    if req.protobuf is not None:
        try:
            raw = base64.b64decode(req.protobuf.encode("ascii"), validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise APIError(CODE_VALIDATION, "Invalid base64 protobuf", details={"error": str(exc)})
        world_id = persistence.import_world(raw, s.data_dir)
        doc, _meta = persistence.load(world_id, s.data_dir)
        return {"id": world_id, "world": doc, "saved_at": _meta.get("saved_at", "")}

    if req.world is None:
        raise APIError(CODE_VALIDATION, "world is required when protobuf is not provided")

    try:
        validate(req.world)
    except APIError:
        raise
    except Exception as exc:
        raise APIError(CODE_VALIDATION, "Invalid world document", details={"error": str(exc)})

    world_id, saved_at = persistence.save(req.world, s.data_dir)
    doc, _meta = persistence.load(world_id, s.data_dir)
    return {"id": world_id, "world": doc, "saved_at": saved_at}


@router.get("/api/worlds")
async def list_worlds() -> Dict[str, Any]:
    s = settings_mod.get_settings()
    metas = persistence.list_worlds(s.data_dir)
    return {"worlds": metas}


@router.get("/api/worlds/{world_id}")
async def get_world(world_id: str = Path(..., min_length=1, max_length=128)) -> Dict[str, Any]:
    s = settings_mod.get_settings()
    try:
        doc, _meta = persistence.load(world_id, s.data_dir)
    except APIError:
        raise
    return {"id": world_id, "world": doc}


@router.delete("/api/worlds/{world_id}")
async def delete_world(world_id: str = Path(..., min_length=1, max_length=128)) -> Dict[str, bool]:
    s = settings_mod.get_settings()
    deleted = persistence.delete(world_id, s.data_dir)
    if not deleted:
        raise APIError(CODE_NOT_FOUND, f"World {world_id!r} not found", details={"id": world_id})
    return {"deleted": True}


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
    app.include_router(interpret_router)

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
