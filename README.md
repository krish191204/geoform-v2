# Geoform

Geoform is a browser-based worldbuilding product. A TypeScript SPA edits a heightfield and renders the result on a Canvas, while a FastAPI backend runs the Mindwerks [WorldEngine](https://github.com/Mindwerks/worldengine) simulation pipeline (plate tectonics, climate, hydrology, biomes) and provides a small save/load store. Settlement suitability is a deterministic, server-side rule engine over the derived layers.

## Architecture

```
                browser (Vite + TS SPA)
                       │
                       │  HTTP /api/*, /health
                       ▼
            Vite dev server  :5173  ── proxies ──►  FastAPI (uvicorn)  :8765
            (src/main.ts, Canvas)                       │
                                                       ▼
                                       vendor/worldengine (pip install -e)
                                       PyPlatec + numpy + noise + protobuf
                                                       │
                                                       ▼
                                          data/worlds/  (durable JSON)
```

Two processes in dev: `npm run dev` (Vite on 5173) and `python -m server.api` (FastAPI on 8765). The Vite dev server proxies `/api/*` and `/health` to 8765 so the browser stays same-origin.

## Prerequisites

- **Python 3.12** — required by `pyproject.toml` and the WorldEngine build.
- **Node.js 20+** — Vite 8 / TypeScript 6.
- **Build toolchain** — needed to compile the `noise` and `numpy` C extensions.
  - Debian/Ubuntu: `sudo apt-get install -y build-essential python3.12-dev`
  - Fedora: `sudo dnf install -y gcc make python3.12-devel`
  - macOS: `xcode-select --install` (Xcode Command Line Tools)
- **Docker** (optional) — only for the `docker compose` path.

## Install

```bash
git clone <repo-url> geoform && cd geoform

# One-shot, idempotent installer (Python venv + deps + WorldEngine editable + npm)
bash scripts/install.sh

# Verify
.venv/bin/python -c "import worldengine; print('worldengine OK')"
```

The installer creates `.venv/` at the repo root, installs `numpy<3`, `noise==1.2.2`, `protobuf`, `pypng`, `fastapi`, `uvicorn[standard]`, `httpx`, `pydantic`, `pytest`, then runs `pip install -e vendor/worldengine`. It also runs `npm install`.

If `bash scripts/install.sh` is unavailable, the equivalent steps are:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip wheel setuptools
.venv/bin/pip install "numpy<3" "noise==1.2.2" protobuf pypng \
                    fastapi "uvicorn[standard]" httpx pydantic pytest pytest-asyncio
.venv/bin/pip install -e vendor/worldengine
npm install
```

## Dev

Two terminals (or one — `npm run dev:all` runs both):

```bash
# Terminal 1 — API
.venv/bin/python -m server.api

# Terminal 2 — frontend (proxies /api → :8765)
npm run dev
```

Open `http://127.0.0.1:5173`. The SPA talks to the API at the same origin via the Vite proxy in `vite.config.ts`.

## Production run

```bash
# Build the SPA into dist/
npm run build

# Serve the API (port from $GEOFORM_API_PORT, default 8765)
.venv/bin/python -m server.api --host 0.0.0.0 --port 8765

# Serve dist/ statically — any static host works
npx serve -s dist -l 5173
# …or nginx, Caddy, S3+CloudFront, etc.
```

Or the containerised path:

```bash
docker compose up --build
```

This brings up two services from the same image: `api` on 8765 and `web` (serving `dist/` via `npx serve`) on 5173, with `web` resolving `api` by service name. The host `./data/` is bind-mounted into the API container for durability.

## API

The authoritative contract is [`docs/contract.md`](docs/contract.md). Endpoints:

| Method | Path                 | Purpose                                  |
|--------|----------------------|------------------------------------------|
| GET    | `/health`            | Liveness probe                           |
| POST   | `/api/generate`      | Generate a fresh world (authoritative)   |
| POST   | `/api/recompute`     | Re-run climate/hydrology after sculpt    |
| POST   | `/api/serialize`     | World → base64 protobuf                  |
| POST   | `/api/deserialize`   | base64 protobuf → World                  |
| POST   | `/api/settlements`   | Per-cell suitability with optional rules |
| POST   | `/api/worlds`        | Save world to disk                       |
| GET    | `/api/worlds`        | List saved worlds                        |
| GET    | `/api/worlds/{id}`   | Load saved world                         |
| DELETE | `/api/worlds/{id}`   | Delete saved world                       |

All errors share the envelope `{"error": "<code>", "message": "<human>", "details": {...}}` with codes `validation`, `not_found`, `timeout`, `conflict`, `internal`.

## Save schema

World documents are JSON with a `schema_version` stamp (currently `1`). Required top-level keys: `name`, `width`, `height`, `seed`, `generation_params`, `layers`. The `layers` object holds `elevation`, `plates`, `ocean`, `precipitation`, `temperature`, `biome`, `humidity`, `permeability`, `watermap`, `irrigation`, `icecap`. Sculpt edits live at `sculpt[]`; settlement state at `settlements.{rules,overrides,cells}`.

Migrations live in [`server/api/migrations.py`](server/api/migrations.py). The server walks older `schema_version` payloads forward through `(from, to, fn)` entries to `CURRENT_VERSION` on every load. Adding a new layer or top-level key means appending a new migration and bumping `CURRENT_VERSION`.

Files persist under `<GEOFORM_DATA_DIR>/worlds/<id>.json` (full doc) plus a sidecar `<id>.meta.json` (`id`, `name`, `width`, `height`, `seed`, `saved_at`). Writes are atomic (write-temp + `os.replace`) so a crash mid-save cannot leave a half-written file.

## Settlement rules

[`server/api/settlements.py`](server/api/settlements.py) is the pure, deterministic rule engine — it imports nothing from `worldengine`, only numpy. Per cell `(x,y)` it scores on:

- **fresh water** — humidity ≥ `min_fresh_water`
- **elevation** — below `max_elevation`; `hills` / `mountain` tagged above
- **coastal** — bonus when 4-neighbour-adjacent to ocean (only if `prefer_coastal`)
- **arable** — precipitation ≥ `arable_threshold` AND temperature in `[0.3, 0.7]`
- **ocean** — cells are forced to `wilderness` with suitability `0.0`

Score is clipped to `[0, 1]`; cells with `score ≥ min_settlement_suitability` (default `0.5`) are labelled `settlement`, otherwise `wilderness`.

`overrides` is an `{ "x,y": "settlement" | "wilderness" | null }` map. A non-null override always wins over the computed rule, and the response carries an `override` field on the cell to record that the user pinned it.

## Tests

```bash
# Client (Vitest; colocated *.test.ts under src/)
npm run test:client

# API (pytest; under tests/)
.venv/bin/pytest tests -q
```

Client test files: `src/world/climate.test.ts`, `src/world/generate.test.ts`, `src/world/noise.test.ts`, `src/world/persist.test.ts`, `src/world/worldengine.test.ts`, `src/render/draw.test.ts`. API tests live in `tests/test_api_smoke.py` and `tests/test_api_integration.py`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs two jobs on every push to `main` and every PR:

- **`api`** — installs the C toolchain, builds `.venv/`, installs Python deps + the vendored WorldEngine, runs `pytest tests -q`.
- **`web`** — `npm ci`, `npm run typecheck`, `npm run test:client`, `npm run build`.

## Vendoring WorldEngine

`vendor/worldengine/` is the upstream Mindwerks WorldEngine source, installed **editable** via `pip install -e vendor/worldengine`. Editing files in `vendor/worldengine/` is reflected immediately — no reinstall required.

To refresh from upstream (this is a destructive operation: stash any local edits first):

```bash
cd vendor/worldengine
git fetch && git pull
cd ../..
.venv/bin/pip install -e vendor/worldengine
```

The vendored `pyproject.toml` declares its own Python deps, which `pip install -e .` resolves automatically. No additional flags are needed unless upstream's deps changed.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All keys are optional — defaults match `.env.example`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEOFORM_API_HOST` | `127.0.0.1` | Bind host for the FastAPI server |
| `GEOFORM_API_PORT` | `8765` | Bind port for the FastAPI server |
| `GEOFORM_WEB_HOST` | `127.0.0.1` | Vite dev server bind host |
| `GEOFORM_WEB_PORT` | `5173` | Vite dev server port |
| `GEOFORM_DATA_DIR` | `./data` | Durable world store root (saves land under `data/worlds/`) |
| `GEOFORM_MIN_WIDTH` | `32` | Lower bound for world width |
| `GEOFORM_MAX_WIDTH` | `2048` | Upper bound for world width |
| `GEOFORM_MIN_HEIGHT` | `32` | Lower bound for world height |
| `GEOFORM_MAX_HEIGHT` | `2048` | Upper bound for world height |
| `GEOFORM_GENERATE_TIMEOUT_MS` | `180000` | `/api/generate` timeout (ms) |
| `GEOFORM_RECOMPUTE_TIMEOUT_MS` | `60000` | `/api/recompute` and `/api/settlements` timeout (ms) |

CLI flags `--host`, `--port`, `--data-dir`, `--log-level` (see `python -m server.api --help`) override env vars.

## License

Geoform is released under the **MIT License**. The vendored WorldEngine (`vendor/worldengine/`) is also MIT-licensed; copyright 2013–2014 Federico Tomassetti and Bret Curtis. See [`vendor/worldengine/LICENSE.txt`](vendor/worldengine/LICENSE.txt).

## Troubleshooting

- **`noise` build fails** with `Python.h: No such file` / `_PyLong_AsByteArray` errors → install the Python dev headers and a C toolchain: `sudo apt-get install -y python3.12-dev build-essential`. Re-run `bash scripts/install.sh`.
- **Port 8765 already in use** → set `GEOFORM_API_PORT=9000` in `.env` (and update the `target` in `vite.config.ts` to match).
- **`ModuleNotFoundError: No module named 'worldengine'`** → the editable install was skipped or the venv isn't activated. Run `.venv/bin/pip install -e vendor/worldengine` from the repo root.
- **Vite proxy returns 502 in the browser** → the API server isn't running on 8765. Start it with `.venv/bin/python -m server.api` in another terminal.
- **Generation hangs / times out** at large dimensions → defaults cap at 2048×2048 and 100 plates; tune `GEOFORM_GENERATE_TIMEOUT_MS` upward, or lower the resolution in the UI.
- **`Schema version X is newer than supported`** on load → your server is older than the file. Upgrade the server or convert the file down with a matching migration.
