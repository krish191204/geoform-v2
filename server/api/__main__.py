"""Entry point: `python -m server.api --host ... --port ...`."""

from __future__ import annotations

import argparse
import logging
import os
import sys

import uvicorn

from . import settings as settings_mod
from .version import __version__


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="server.api",
        description="Geoform Python API server (WorldEngine-backed).",
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
    p.add_argument("--version", action="version", version=f"geoform {__version__}")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.host is not None:
        os.environ["GEOFORM_API_HOST"] = args.host
    if args.port is not None:
        os.environ["GEOFORM_API_PORT"] = str(args.port)
    if args.data_dir is not None:
        os.environ["GEOFORM_DATA_DIR"] = args.data_dir

    s = settings_mod.reset_settings_for_tests()
    s.ensure_dirs()

    log = logging.getLogger("geoform.api")
    log.info("Starting Geoform API on %s:%s (data_dir=%s)", s.host, s.port, s.data_dir)

    uvicorn.run(
        "server.api.app:app",
        host=s.host,
        port=s.port,
        log_level=args.log_level,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
