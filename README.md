# Geoform

Geoform is a browser-based worldbuilding tool. A TypeScript SPA edits a heightfield and renders it on a canvas; a FastAPI server wraps the vendored [WorldEngine](https://github.com/Mindwerks/worldengine) simulation pipeline (plate tectonics, erosion, climate, hydrology, Holdridge biomes) and owns world generation, recompute, persistence, and a deterministic settlement-suitability rule engine.

The server is authoritative: the client treats every `/api/generate` and `/api/recompute` response as canonical state.

## Architecture

```
  browser (Vite + TS SPA, src/)
          │  fetch /api/*, /health
          ▼
  Vite dev server :5173  ──proxy──►  FastAPI + uvicorn :8765  (server/api/)
  (dev only; prod serves dist/)              │
                                             ▼
                              vendor/worldengine  (pip install -e)
                              numpy · noise · protobuf · pypng
                                             │
                                             ▼
                              $GEOFORM_DATA_DIR/worlds/  (JSON + .meta.json)
```

In dev these are two processes. In production the SPA is a static bundle (`dist/`) served by any web server, talking to the API over `/api`.

## Prerequisites

- **Python 3.12** and **python3.12-dev** (headers — `noise` builds a C extension)
- **Node 20+**
- **build-essential** (or equivalent C toolchain; `xcode-select --install` on macOS)

```bash
sudo apt-get install -y python3.12-dev build-essential
```

## Install

```bash
# Backend (one-time)
python3 -m venv .venv
.venv/bin/pip install --upgrade pip wheel setuptools
.venv/bin/pip install 'numpy<3' 'noise==1.2.2' protobuf pypng fastapi 'uvicorn[standard]' httpx pydantic pytest pytest-asyncio
.venv/bin/pip install -e vendor/worldengine

# Frontend (one-time)
npm install
```

`bash scripts/install.sh` (also `npm run install:all`) runs exactly these steps and is idempotent.

Verify:

```bash
.venv/bin/python -c "import worldengine; print('worldengine ok')"
```

## Dev

```bash
npm start      # terminal 1 — API on 127.0.0.1:8765
npm run dev    # terminal 2 — Vite on 127.0.0.1:5173
```

Open <http://127.0.0.1:5173>. Vite proxies `/api/*` and `/health` to `127.0.0.1:8765` (see `vite.config.ts`), so the browser stays same-origin and there is no CORS config.

> **Known divergence.** There are currently two server implementations, both binding 8765 — run only one:
> - `server/api/` (FastAPI, started by `npm start`) implements `docs/contract.md` and is what the test suite covers.
> - `server/worldengine_api.py` (stdlib `http.server`, started by `npm run dev:api`, and by `npm run dev:all` together with Vite) is an older bridge with a different wire format.
>
> The SPA in `src/world/worldengine.ts` still posts the older bridge's shape (`{seed, width, height, numPlates}`), which `server/api` rejects. Converging the client onto `docs/contract.md` is outstanding work.

## Production run

```bash
npm run build            # type-checks, then emits the static SPA to dist/
npm start                # API on 127.0.0.1:8765 (npm run start:prod binds 0.0.0.0)
npx serve dist           # or nginx, Caddy, S3+CloudFront, …
```

`dist/` is a plain static bundle. Point your web server at it and route `/api` and `/health` to the API process.

A `Dockerfile` and `docker-compose.yml` are present (`npm run docker:up`); they are not exercised by CI.

## API contract

[`docs/contract.md`](docs/contract.md) is authoritative for every endpoint, bound, and error code — read it before changing a request or response shape. Summary: `GET /health`, `POST /api/generate`, `POST /api/recompute`, `POST /api/serialize`, `POST /api/deserialize`, `POST /api/settlements`, and CRUD at `POST|GET /api/worlds` + `GET|DELETE /api/worlds/{id}`.

All errors share one envelope, `{"error": "<code>", "message": "<human>", "details": {...}}`, with codes `validation`, `not_found`, `timeout`, `conflict`, `internal`. The server never returns 200 with a partial result.

## Save schema

World documents are JSON stamped with `schema_version` (currently `1`). Top level: `name`, `width`, `height`, `seed`, `generation_params`, `temps`, `humids`, `gamma_curve`, `curve_offset`, `layers`, `sculpt`, `settlements`. `layers` holds `elevation`, `plates`, `ocean`, `precipitation`, `temperature`, `biome`, `humidity`, `permeability`, `watermap`, `irrigation`, `icecap` (plus `sea_depth`, `lake_map`, `river_map`), each as `{"data": [[...]]}` in row-major `(height, width)` order. `biome` is an integer index into `worldengine.biome`.

Migrations live in [`server/api/migrations.py`](server/api/migrations.py). Documents are walked forward through `(from, to, fn)` steps to `CURRENT_VERSION` on every load, so older saves keep opening. Adding a layer or top-level key means appending a migration and bumping `CURRENT_VERSION`.

Saves land in `$GEOFORM_DATA_DIR/worlds/<id>.json` with a sidecar `<id>.meta.json` (`id`, `name`, `width`, `height`, `seed`, `saved_at`). Writes are atomic (temp file + `os.replace`).

`sculpt` stores brush strokes (`{x, y, radius, delta, tool}`) rather than elevation history; recompute replays them, which keeps edits deterministic and saves small.

## Settlement rules

[`server/api/settlements.py`](server/api/settlements.py) is a pure numpy function of `(world, rules, overrides)` — same inputs always give the same output. Each land cell starts at **0.5** and accumulates:

| Signal | Condition | Δ |
|---|---|---|
| `fresh_water` / `low_fresh_water` | humidity ≥ / < `min_fresh_water` | +0.15 / −0.30 |
| `low_lying` / `hills` / `mountain` | elevation ≤ 60% of / above 60% of / above `max_elevation` | +0.10 / 0 / −0.25 |
| `coastal` | 4-neighbour-adjacent to ocean, when `prefer_coastal` | +0.20 |
| `arable` | precipitation ≥ `arable_threshold` **and** 0.3 ≤ temperature ≤ 0.7 | +0.15 |

The score is clipped to `[0, 1]`. Cells scoring ≥ `min_settlement_suitability` (default 0.5) get `rule: "settlement"`, else `"wilderness"`. Ocean cells short-circuit to suitability `0.0`, `rule: "wilderness"`, `reasons: ["ocean"]`.

`overrides` maps `"x,y"` → `"settlement" | "wilderness" | null`. **A non-null override always beats the computed rule**, and the cell echoes it back in `override` so the UI can show which cells the user pinned.

## Tests

```bash
npm test              # client + API
npm run test:client   # vitest run           — 32 tests in src/**/*.test.ts
npm run test:api      # pytest tests -q      — 20 tests in tests/
```

The Python suite boots a real `python -m server.api` subprocess on an OS-assigned free port with a temp `GEOFORM_DATA_DIR` (see `tests/conftest.py`), so it exercises startup, routing, validation, and the on-disk store rather than mocks. `tests/test_api_smoke.py` additionally covers the app in-process via `TestClient`.

`tests/test_e2e_smoke.py` walks the full journey — generate → score → sculpt → recompute → re-score → save → load → delete — and checks that `dist/` is servable (skipped unless you have run `npm run build`).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes to `main` and on every PR, with two jobs:

- **`api`** — Python 3.12, installs `python3.12-dev` + `build-essential`, builds `.venv`, installs the Python deps and `pip install -e vendor/worldengine`, runs `pytest tests -q`. pip and `.venv` are cached (best-effort) on a key derived from `vendor/worldengine/pyproject.toml` and `package.json`.
- **`web`** — Node 20, `npm ci`, `npm run typecheck`, `npm run test:client`, `npm run build`.

## Vendoring WorldEngine

`vendor/worldengine/` is an upstream WorldEngine source drop, installed editable from `vendor/worldengine/pyproject.toml`:

```bash
.venv/bin/pip install -e vendor/worldengine
```

Editable means changes under `vendor/worldengine/` take effect without reinstalling; reinstall only when upstream's dependencies or entry points change.

To refresh, replace the tree with a newer upstream checkout and reinstall:

```bash
git clone https://github.com/Mindwerks/worldengine /tmp/worldengine
rm -rf vendor/worldengine && cp -a /tmp/worldengine vendor/worldengine
.venv/bin/pip install -e vendor/worldengine
```

> The vendored tree is **not** a git clone or submodule here — it has no remote, and `git -C vendor/worldengine …` resolves to *this* repository, so `git -C vendor/worldengine pull` would not do what it looks like it does. If you re-vendor it as a real clone or submodule, `git -C vendor/worldengine pull && .venv/bin/pip install -e vendor/worldengine` becomes the refresh path.

## Configuration

Copy `.env.example` to `.env`; every key is optional and defaults to the value below. The server also reads `--host`, `--port`, `--data-dir`, and `--log-level` (`python -m server.api --help`), which override the environment.

| Variable | Default | Purpose |
|---|---|---|
| `GEOFORM_API_HOST` | `127.0.0.1` | API bind host |
| `GEOFORM_API_PORT` | `8765` | API bind port |
| `GEOFORM_WEB_HOST` | `127.0.0.1` | Vite dev server host |
| `GEOFORM_WEB_PORT` | `5173` | Vite dev server port |
| `GEOFORM_DATA_DIR` | `./data` | Durable store root; worlds land in `<dir>/worlds/` |
| `GEOFORM_MIN_WIDTH` / `GEOFORM_MAX_WIDTH` | `32` / `2048` | World width bounds |
| `GEOFORM_MIN_HEIGHT` / `GEOFORM_MAX_HEIGHT` | `32` / `2048` | World height bounds |
| `GEOFORM_GENERATE_TIMEOUT_MS` | `180000` | `/api/generate` timeout |
| `GEOFORM_RECOMPUTE_TIMEOUT_MS` | `60000` | `/api/recompute` and `/api/settlements` timeout |

No secrets are required to run, build, or test Geoform.

## License

MIT — see [`LICENSE`](LICENSE). Geoform vendors [WorldEngine](https://github.com/Mindwerks/worldengine) (© Federico Tomassetti, Bret Curtis), also MIT; its text is at [`vendor/worldengine/LICENSE.txt`](vendor/worldengine/LICENSE.txt).

## Troubleshooting

- **`fatal error: Python.h: No such file or directory`** while installing `noise` → missing headers: `sudo apt-get install -y python3.12-dev build-essential`, then re-run the install.
- **`ModuleNotFoundError: No module named 'worldengine'`** → the editable install was skipped: `.venv/bin/pip install -e vendor/worldengine`.
- **`Address already in use` on 8765** → another API process (or the other server implementation) is running. Stop it, or set `GEOFORM_API_PORT` and update the proxy `target` in `vite.config.ts` to match.
- **Vite returns 502 for `/api/*`** → the API isn't running; start it with `npm start`.
- **Status reads `WorldEngine error: Bad Gateway. Is the API running?` and won't go away** → the SPA fired its boot-time `loadWorld` (`src/main.ts:138`) while the API was down or restarting, and the client does not auto-retry. The API may now be fine — reload the page, or click **Randomize** in the toolbar to trigger a fresh `/api/generate`. Verify with `curl http://127.0.0.1:8765/health` and `curl http://127.0.0.1:5173/health` (both should return `{"status":"ok"}`).
- **`vitest: not found` / `Cannot find package 'rolldown'`** → stale `node_modules`: `rm -rf node_modules && npm ci`.
- **Generation times out** on large maps → raise `GEOFORM_GENERATE_TIMEOUT_MS`, or generate smaller (bounds cap at 2048×2048, 100 plates).
- **`pytest: command not found`** → use the venv: `.venv/bin/python -m pytest tests -q` (or `npm run test:api`).
