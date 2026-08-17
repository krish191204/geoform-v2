---
name: geoform-atlas-look
description: >-
  Makes Geoform's atlas and globe look like Geoform 1 (paper-ink, bilinear
  relief, continuous shores) without changing Make-sense geography. Use when
  improving map beauty, resolution, hillshade, grain, vignette, globe
  textures, displacement seams, or comparing to https://geoform-snowy.vercel.app/.
  Do not use this to swap in Mapbox, MapLibre, R3F, or procedural planets.
---

# Geoform atlas look

Visual target is Geoform 1. Geography stays v2. This skill is the gate for any look work.

## Hard constraints

- Do not change plates, climate, hydrology, biomes, or mask-lock to make the picture prettier.
- Do not mutate `input.mask`. Do not debounce Make sense onto strokes. Do not `loadWorld()` on boot.
- Pipeline modules must not import `src/world/` or `src/app/`.
- Do not add Mapbox, MapLibre, deck.gl, Kepler, R3F, or a second globe engine.
- Sketch is mask-only. Derived climate, layers, and Planet view stay off Sketch.
- Pixel-cell blit is a bug. Bilinear upsample + CSS downsample is the paper look.

## Where look lives

| Surface | Files | Allowed changes |
|---|---|---|
| Atlas raster | `src/render/draw.ts`, `src/app/atlas.ts` | `cellColor`, hillshade, grain, vignette, bake width |
| Globe | `src/render/globe.ts` + draw bakes | wrap, color space, bake scale, lighting, displacement |
| Chrome | `src/style.css`, `src/app/ui.ts` | paper, not a new UI |
| Geography | `src/pipeline/*` | **off limits** for beauty passes |

## Skill routing

1. Always follow this skill first.
2. Globe / WebGL / textures / materials / lights → read `.agents/skills/three-js` (vanilla Three.js only). Ignore R3F, GLTF product scenes, WebXR, physics.
3. Color ramps, one-message-per-layer, honest class breaks → read `.agents/skills/cartography-geoviz`. Ignore Folium / MapLibre / QGIS output. Apply ideas inside `cellColor` / layer ramps only.
4. Ignore Render.com skills (`render-*`) for look work.

## Look checklist (do not skip)

- Atlas bakes at least 4 px/cell then `drawImage` down (`atlasBakeWidth`).
- Smooth layers bilinear; plates stay nearest-neighbour.
- Hillshade on relief/biome; grain + vignette stay seeded and static (`draw` stays pure).
- Globe: `wrapS = RepeatWrapping`, linear color space on bump/normal/displacement, sRGB on the color map. No date-line trench.
- Compare to Geoform 1 live, not to the writer's pixels.

## Full plan

See [PLAN.md](PLAN.md).
