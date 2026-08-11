# Geoform API Contract (v1)

This document is the authoritative reference for the HTTP API exposed by
`server/api`. All clients (UI, tests, CLI tools) MUST conform to it.

## Base URL

- Dev: `http://127.0.0.1:8765` (Vite proxies `/api/*` and `/health` here)
- Prod: whatever process manager / reverse proxy fronts `python -m server.api`

## Bounds (enforced server-side)

| Field        | Min | Max | Default |
|--------------|-----|-----|---------|
| `width`      | 32  | 2048 | 256 |
| `height`     | 32  | 2048 | 192 |
| `num_plates` | 1   | 100  | 8   |
| `seed`       | 0   | 65535 | random |

A request violating bounds returns `400 Bad Request` with
`{"error": "validation", "field": "...", "message": "..."}`.

## Endpoints

### `GET /health`

Liveness probe. Always returns `200 {"status":"ok","version":"<pkg>"}`.

### `POST /api/generate`

Generate a fresh world from scratch. This is the authoritative entry point —
the client MUST treat the response as canonical state and persist it.

Request:
```json
{
  "name": "string",
  "width": 256,
  "height": 192,
  "seed": 12345,
  "num_plates": 8,
  "ocean_level": 1.0,
  "step": "full" | "plates" | "precipitations",
  "fade_borders": true,
  "temps": [0.874, 0.765, 0.594, 0.439, 0.366, 0.124],
  "humids": [0.941, 0.778, 0.507, 0.236, 0.073, 0.014, 0.002],
  "gamma_curve": 1.25,
  "curve_offset": 0.2
}
```

Response (`200`): a `World` JSON document (see schema below).

Error codes:
- `400 validation` – bounds / required fields
- `408 timeout`    – generation exceeded `GEOFORM_GENERATE_TIMEOUT_MS`
- `500 internal`   – WorldEngine raised; message includes `stage` and a redacted `error`

### `POST /api/recompute`

Re-run the simulation pipeline on a previously-generated world (e.g. after a
sculpt edit). The client MUST send the full current world. The server replaces
the derived layers (`ocean`, `precipitation`, `temperature`, `biome`, `humidity`,
`permeability`, `watermap`, `irrigation`, `icecap`) in-place.

Request:
```json
{
  "world": { ...World... }
}
```

Response (`200`): the same world document, with derived layers refreshed.
The server's protobuf serialization of the resulting world MUST be byte-stable
when fed back into `/api/recompute` with no edits (deterministic).

### `POST /api/serialize`

Convert a `World` to protobuf bytes (base64-encoded) for compact storage /
transport. Request: `{"world": {...}}`. Response: `{"protobuf": "<base64>"}`.

### `POST /api/deserialize`

Inverse of `serialize`. Request: `{"protobuf": "<base64>"}`. Response:
`{"world": {...}}`. Used for round-trip tests and import flows.

### `POST /api/settlements`

Compute settlement suitability per cell using deterministic rules. The client
may override individual cells in `overrides`.

Request:
```json
{
  "world": { ...World... },
  "rules": {
    "min_fresh_water": 0.2,
    "max_elevation": 1.8,
    "prefer_coastal": true,
    "arable_threshold": 0.35
  },
  "overrides": { "x,y": "settlement" | "wilderness" | null }
}
```

Response:
```json
{
  "cells": {
    "x,y": {
      "suitability": 0.0,            // 0..1, higher = better site
      "rule": "settlement" | "wilderness" | null,
      "reasons": ["coastal", "fresh_water", "arable"],
      "override": null               // present when user overrode the rule
    }
  }
}
```

Suitability is pure & deterministic given the same world + rules + overrides.

### `POST /api/worlds`

Persist a world to the durable store under `data/worlds/`. The server assigns
`id` and stamps `created_at`/`updated_at`.

Request: `{"world": {...}}` or `{"protobuf": "<base64>"}`.
Response: `{"id": "...", "world": {...}, "saved_at": "ISO8601"}`.

### `GET /api/worlds`

List saved worlds. Response: `{"worlds": [{"id", "name", "width", "height",
"seed", "saved_at"}]}`.

### `GET /api/worlds/{id}`

Load a saved world. Response: `{"id": "...", "world": {...}}`.

### `DELETE /api/worlds/{id}`

Delete a saved world. Response: `{"deleted": true}`.

## Save schema (versioned, migratable)

`World` documents are JSON with a version stamp:

```json
{
  "schema_version": 1,
  "name": "...",
  "width": 256,
  "height": 192,
  "seed": 12345,
  "generation_params": {
    "n_plates": 8,
    "ocean_level": 1.0,
    "step": "full",
    "fade_borders": true
  },
  "temps": [...],
  "humids": [...],
  "gamma_curve": 1.25,
  "curve_offset": 0.2,
  "layers": {
    "elevation":      { "data": [[...]] },
    "plates":         { "data": [[...]] },
    "ocean":          { "data": [[...]] },
    "precipitation":  { "data": [[...]], "thresholds": [...] },
    "temperature":    { "data": [[...]], "thresholds": [...] },
    "biome":          { "data": [[...]], "quantiles": {...} },
    "humidity":       { "data": [[...]], "thresholds": [...] },
    "permeability":   { "data": [[...]], "thresholds": [...] },
    "watermap":       { "data": [[...]] },
    "irrigation":     { "data": [[...]] },
    "icecap":         { "data": [[...]] }
  },
  "sculpt": [
    { "x": 100, "y": 80, "radius": 8, "delta": 0.5, "tool": "raise" }
  ],
  "settlements": {
    "rules": { ... },
    "overrides": { "x,y": "settlement" | "wilderness" | null },
    "cells":   { "x,y": { ... } }
  }
}
```

Migrations live in `server/api/migrations.py`. The server auto-upgrades
older `schema_version` on load. Adding a new layer requires a new version.

### Layer data types

- Numeric layers (`elevation`, `plates`, `precipitation`, `temperature`,
  `humidity`, `permeability`, `watermap`, `irrigation`, `icecap`, `ocean`):
  rows × cols of numbers (booleans serialized as 0/1).
- `biome` is encoded as an integer index (`worldengine.biome.Biome`) plus a
  `name_index` for human-readable name lookup.

### `sculpt`

A list of brush strokes. Recompute applies them in order to a fresh
elevation layer generated from the saved seed before running downstream
simulations. This keeps determinism without storing the full elevation
history.

## Errors

All errors share the envelope:
```json
{ "error": "<code>", "message": "<human>", "details": { ... } }
```

Codes: `validation`, `not_found`, `timeout`, `conflict`, `internal`.

The server never returns a 200 with a partial result. Any failure during
generate/recompute produces an explicit error.
