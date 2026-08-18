# Plan: better look, same planet

Geoform already has the geography. This plan is only about making the **picture** match Geoform 1 without touching Make sense.

## 1. What we searched, what we refused

| Candidate | Why refused |
|---|---|
| Mapbox GL / MapLibre terrain-patterns | Would replace the canvas atlas with a tile engine and DEM tiles. Not this product. |
| MapV-Three, Kepler, deck.gl | Different renderer, different data model. |
| threejs-procedural-planets | Would invent a new planet instead of draping v2 arrays. |
| full-stack-skills 18-pack (WebXR, audio, TSL, loaders) | Noise. Globe is one sphere + baked textures. |
| Game terrain-integration / R3F | Wrong stack (`src/render/globe.ts` is vanilla Three). |
| Ads grain-overlay / CSS film packs | Look already lives in `cellColor` + `applyVignette`. Extra DOM overlays fight the bake. |

## 2. What we added (and why)

| Skill | Role |
|---|---|
| **geoform-atlas-look** (this) | Gate. Geoform 1 paper look, file map, non-negotiables. |
| **three-js** (`noklip-io/agent-skills`) | Vanilla Three.js textures, materials, lights, wrap, disposal, performance. Globe only. |
| **cartography-geoviz** (`muend/geoai-skills`) | Honest ramps (one message per layer). Ideas only — implement in `draw.ts`, never Folium. |

Render.com skills already in `.agents/skills/render-*` are for hosting. They are not part of this look plan.

## 3. Architecture (do not redraw)

```
Sketch mask  →  Make sense (plates → orogeny → climate → rivers → biomes)
                      ↓
                   World arrays
                      ↓
         draw.ts  →  atlas.ts (2D paper)     globe.ts (sphere)
```

Beauty work happens **below** World. If a change would move a mountain, a river, or a coast to look nicer, stop.

## 4. Phased work

Do these in order. Each phase is look-only. Stop if a test in `src/pipeline/` would need to change.

### Phase A — Atlas paper (highest leverage)

Files: `src/render/draw.ts`, `src/app/atlas.ts`

- Keep HD grid (768×384) and `atlasBakeWidth` oversample.
- Relief: bilinear hillshade, coast ink, river mix, seeded grain, vignette — already present; tune toward Geoform 1, do not replace with nearest-neighbour blit.
- Layer chips: one message each (cartography-geoviz). Temperature ramp stays temperature; do not hide climate under prettier green.
- Sketch mask upsample stays bilinear; Sketch still must not show derived layers.

### Phase B — Globe continuity

Files: `src/render/globe.ts`, displacement/normal/bump bakes in `draw.ts`

Use **three-js** for:

- Date-line wrap (`RepeatWrapping` on S, clamp on T) — already started.
- Linear vs sRGB on the right maps.
- Softer pole pinch (fade displacement near poles in the **bake**, not by flattening World elev).
- Lighting: keep paper-day key + cool fill; no HDRI product-shot setup.
- Dispose textures on resync (already); do not add EffectComposer bloom that reads as sci-fi.

### Phase C — Compare, don't invent

- Side-by-side with https://geoform-snowy.vercel.app/ (empty ocean grain, relief after generate).
- If Geoform 1 does something we lack (foam, grain, vignette strength), port the **recipe** into `cellColor` / `applyVignette`.
- If Geoform 1 fakes geography we already compute, do not copy the fake.

### Out of scope

- Moving continents, relaxing mask-lock, or “more interesting” coasts for the camera.
- New UI chrome, quality dropdowns, or a third renderer.
- `--prod` deploy, `loadWorld()` on boot, Make sense on every stroke.

## 5. How an agent should run a look pass

1. Read this skill + `PLAN.md`.
2. Touch only the files in the current phase.
3. If three-js suggests a new mesh, shader rewrite, or postprocessing stack — refuse unless it maps 1:1 onto the existing `MeshStandardMaterial` + baked maps.
4. If cartography-geoviz suggests MapLibre hillshade layers — translate to the existing `SHADE_M` hillshade in `cellColor`.
5. Run `npx vitest run src/render/draw.test.ts src/app/atlas.test.ts src/app/ui.test.ts`. Pipeline goldens must stay byte-identical.
6. Do not commit unless asked.

## 6. Success

The atlas looks like a printed sheet (soft shores, hillshade, grain), the globe is a continuous planet (no date-line cut), and the **World arrays are unchanged**.
