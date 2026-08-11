# Architecture

One-page reference for Geoform's runtime flows. The authoritative API contract lives in [`contract.md`](contract.md); this document focuses on *how* requests move through the system.

## Runtime request flow

The SPA is served by Vite in dev (port 5173) or by any static host in production. The API is always FastAPI on port 8765. Vite proxies `/api/*` and `/health` to keep the browser same-origin.

```mermaid
flowchart LR
  Browser[Browser<br/>src/main.ts + Canvas]
  Vite[Vite :5173<br/>proxies /api, /health]
  API[FastAPI :8765<br/>server/api/app.py]
  WE[WorldEngine<br/>vendor/worldengine<br/>editable pip install]
  Disk[(data/worlds/<br/>atomic JSON)]

  Browser -- "fetch /api/generate" --> Vite
  Vite -- "proxy" --> API
  API -- "world_engine.generate_world()" --> WE
  WE -- "protobuf bytes" --> API
  API -- "World JSON" --> Vite
  Vite -- "JSON" --> Browser

  Browser -- "fetch /api/worlds" --> Vite
  Vite --> API
  API -- "persistence.save() / load()" --> Disk
  Disk --> API
  API --> Vite --> Browser
```

Equivalently, in plain ASCII:

```
browser ─► Vite :5173 ─► FastAPI :8765 ─► WorldEngine (numpy + PyPlatec)
                  ▲                  │
                  └──── JSON ◄───────┘
                                     │
                       data/worlds/ ◄┘   (only for /api/worlds*)
```

`/api/generate` runs `worldengine.plates.world_gen` plus the full downstream simulation chain (temperature, precipitation, erosion, watermap, irrigation, humidity, permeability, biome, icecap) inside a worker thread, bounded by `GEOFORM_GENERATE_TIMEOUT_MS`. `/api/recompute` skips the plate sim and replays downstream layers after applying the client's `sculpt[]` strokes.

## Save / load flow

Saves go to `<GEOFORM_DATA_DIR>/worlds/<id>.json` (the full migrated World document) plus a sibling `<id>.meta.json` carrying `{id, name, width, height, seed, saved_at}`. Writes are atomic (`write-to-tmp` + `os.replace`).

```mermaid
sequenceDiagram
  participant C as Client (SPA)
  participant A as FastAPI
  participant M as migrations.py
  participant D as data/worlds/

  C->>A: POST /api/worlds { world }
  A->>M: validate() / migrate()
  M-->>A: doc with schema_version = CURRENT
  A->>D: atomic write <id>.json + <id>.meta.json
  D-->>A: ok
  A-->>C: { id, world, saved_at }

  C->>A: GET /api/worlds/{id}
  A->>D: read <id>.json
  D-->>A: bytes
  A->>M: migrate() on load
  M-->>A: doc
  A-->>C: { id, world }
```

The migration walker in `server/api/migrations.py` is invoked on **every** load (and on save, for inbound payloads), so a stale on-disk file with an older `schema_version` is upgraded transparently before being returned to the client.

## Sculpt → recompute flow

When the user paints heightfield strokes, the SPA sends the full world back to `/api/recompute` (the server is authoritative — the TS-side climate preview is just a fast in-browser approximation).

```mermaid
sequenceDiagram
  participant U as User (brush)
  participant S as SPA (src/main.ts)
  participant V as Vite proxy
  participant A as FastAPI
  participant W as world_engine.py
  participant WE as WorldEngine

  U->>S: paintElevation(raise, x, y, r, δ)
  S->>S: local preview (climate.ts, immediate)
  S->>S: debounce ~650 ms
  S->>V: POST /api/recompute { world, sculpt }
  V->>A: proxy
  A->>W: from_dict(world) + apply_sculpt(sculpt)
  W->>WE: rebuild elevation, re-run downstream sims
  WE-->>W: derived layers refreshed
  W-->>A: dict
  A-->>V: World JSON
  V-->>S: World JSON
  S->>S: replace in-memory arrays (Float32Array/Int16Array)
  S->>S: trigger rAF render
```

The `sculpt[]` array is a list of brush strokes `{x, y, radius, delta, tool}`. On recompute the server applies them in order to a fresh elevation layer generated from the saved seed, then runs the full downstream sim — this keeps determinism without storing the full edit history.

## Boundaries

- **Browser** owns the heightfield, the canvas, autosave, and user input.
- **FastAPI** owns simulation, settlement rules, persistence, and migrations.
- **WorldEngine** owns tectonic and climate numerics; it never reaches into the network or the disk.
- **Disk** owns durability — it is the only state that survives a restart.
