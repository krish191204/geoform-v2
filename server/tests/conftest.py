"""Session-scoped fixtures that run the real Geoform API server in a subprocess.

The integration suite talks to a live server over HTTP — no TestClient, no
monkeypatching — so it exercises startup, routing, validation and the on-disk
world store the same way the browser client does.

Isolation:
  * the server binds an OS-assigned free port (parallel-safe)
  * ``GEOFORM_DATA_DIR`` points at a pytest tmp dir, so ``/api/worlds`` writes
    never touch the repo's ``data/``
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# The server must run out of the project venv: it needs worldengine, numpy and
# the noise C extension, none of which are on the system interpreter.
VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

# How long the fixture waits for /health before giving up. Deliberately much
# larger than the boot budget asserted in test_health_boots_fast: a slow boot
# should fail one explicit assertion, not blow up the whole session.
BOOT_TIMEOUT_S = 60.0

# Generation of a small world should be quick, but plate simulation is CPU-bound
# and CI runners are slow, so give requests plenty of room.
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=60.0, pool=60.0)


def _free_port() -> int:
    """Ask the OS for an unused TCP port and release it immediately."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@dataclass
class ServerHandle:
    """Everything a test might need to know about the running server."""

    base_url: str
    boot_seconds: float
    data_dir: Path
    log_path: Path
    process: subprocess.Popen


def _python_executable() -> str:
    if VENV_PYTHON.exists():
        return str(VENV_PYTHON)
    # Fall back to whatever interpreter is running pytest (e.g. an already
    # activated venv, or CI where the venv lives elsewhere).
    return sys.executable


def _tail(path: Path, limit: int = 4000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:  # pragma: no cover - only on a broken tmp dir
        return f"<could not read server log: {exc}>"
    return text[-limit:] if len(text) > limit else text


def _wait_for_health(base_url: str, process: subprocess.Popen, log_path: Path) -> float:
    """Poll /health until it answers 200. Returns seconds elapsed since spawn.

    Raises with the server log attached if the process dies or never answers —
    a silent timeout here is the single most confusing failure mode for an
    integration suite, so we always surface stderr.
    """
    started = getattr(process, "_geoform_spawned_at")
    deadline = started + BOOT_TIMEOUT_S
    with httpx.Client(base_url=base_url, timeout=httpx.Timeout(5.0)) as probe:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(
                    f"API server exited with code {process.returncode} during startup.\n"
                    f"--- server log ---\n{_tail(log_path)}"
                )
            try:
                response = probe.get("/health")
            except httpx.HTTPError:
                time.sleep(0.05)
                continue
            if response.status_code == 200:
                return time.monotonic() - started
            time.sleep(0.05)

    raise RuntimeError(
        f"API server did not answer /health within {BOOT_TIMEOUT_S:.0f}s.\n"
        f"--- server log ---\n{_tail(log_path)}"
    )


@pytest.fixture(scope="session")
def server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ServerHandle]:
    """Start `python -m server.api` once per session and tear it down after."""
    data_dir = tmp_path_factory.mktemp("geoform-data")
    log_path = tmp_path_factory.mktemp("geoform-logs") / "server.log"
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"

    env = os.environ.copy()
    env.update(
        {
            "GEOFORM_API_HOST": "127.0.0.1",
            "GEOFORM_API_PORT": str(port),
            "GEOFORM_DATA_DIR": str(data_dir),
            "PYTHONUNBUFFERED": "1",
            # `-m server.api` must resolve from the repo root even if pytest was
            # invoked from elsewhere.
            "PYTHONPATH": str(REPO_ROOT),
        }
    )

    command = [
        _python_executable(),
        "-m",
        "server.api",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
    ]

    with log_path.open("wb") as log_file:
        spawned_at = time.monotonic()
        process = subprocess.Popen(
            command,
            cwd=str(REPO_ROOT),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
        setattr(process, "_geoform_spawned_at", spawned_at)
        try:
            boot_seconds = _wait_for_health(base_url, process, log_path)
        except Exception:
            process.kill()
            process.wait(timeout=10)
            raise

        try:
            yield ServerHandle(
                base_url=base_url,
                boot_seconds=boot_seconds,
                data_dir=data_dir,
                log_path=log_path,
                process=process,
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - stubborn child
                process.kill()
                process.wait(timeout=10)


@pytest.fixture(scope="session")
def client(server: ServerHandle) -> Iterator[httpx.Client]:
    """HTTP client bound to the live server."""
    with httpx.Client(base_url=server.base_url, timeout=HTTP_TIMEOUT) as http_client:
        yield http_client
