# Geoform — Mission, Identity, and Optimization Plan

_Last updated: 27 Aug 2026. Grounded in a code audit of `src/pipeline/`, `src/sketch/`, `src/app/`, and `src/render/` — file references throughout._

---

## 1. Mission, specified

> **Geoform takes a writer's doodle and returns a planet that would survive a geographer's glance — and shows its work.**

Four pillars, each with a hard test:

| Pillar | Meaning | Test |
| --- | --- | --- |
| **Honesty** | Never lie about a cell. Sketch notes are notes; derived geography is derived. | Hover any cell: the readout must be defensible to a geography teacher. |
| **Provenance** | Every fact traces to a cause (plate collision → range; rain shadow → desert). | The user can always ask "why is this here?" and get an answer. |
| **Weathering** | The world reads as *old* — shaped by process over time, not stamped. | Coasts, valleys, and deserts look eroded, not procedural. |
| **Instrument, not app** | The UI is a survey plate and drafting table, not a SaaS dashboard. | Screenshots read as cartography before they read as software. |

The existing workspace rule stays sovereign: geographical accuracy beats sketch fidelity; Make sense may (should) move the pixels.

---

## 2. Visual identity verdict — is orange/white/beige right?

**Half right.** The paper-ink core is correct for a survey instrument. The current *execution* undercuts the "weathering + real science" identity:

**What works**
- Paper ground + deep-sea navy: correct atlas language.
- Fraunces display + Spline Sans Mono data: credible drafting-table typography.
- The new engraved cartouche and solid instrument panels move in the right direction.

**What fights the identity**
- The accent `--copper #b85a2a` reads *craft-store terracotta*, not oxidised survey ink. It says "friendly stationery brand," not "field science."
- Too many undifferentiated creams/beiges with equal tonal weight — real survey plates have strong ink authority against paper (near-black linework, sparse colour used as *meaning*).
- Pill-shaped buttons everywhere (999px radii) are consumer-app language. Instruments use rules, ticks, and square plates. (The cartouche already breaks this correctly.)
- Nothing in the chrome encodes **weathering or time** — the product's core fantasy. No grain, no contour texture, no erosion metaphor anywhere outside the map itself.

**Direction (palette v2)**
- Keep: paper `#e7e0d2`, ink `#1c221c`, deep sea.
- Shift accent: copper → **iron-oxide / burnt sienna** (`#a04a22` family) used *only* for irreversible acts (Make sense, Worldbuild) — colour as meaning.
- Add secondary: **verdigris** (`#4a7a6a` family) for derived-world facts — the colour of aged bronze instruments; it also separates "grounded" info from sketch info at a glance.
- Ink authority: panel headers and rules move closer to full ink; captions stay soft.
- Texture: a very subtle paper-grain overlay on panels and a hachure/contour tick motif on section rules (CSS only, no map changes).
- Shape: keep pills for *chips* (togglable states), move action buttons to 6–8px radii; plates and dialogs get the double-rule engraved frame like the cartouche.

---

## 3. Science accuracy audit (yes — the code was read)

### What is genuinely modelled (stronger than it looks)

| Mechanism | Where | Verdict |
| --- | --- | --- |
| Plate assignment + boundary classes (CC/OC/divergent/transform) | `pipeline/plates.ts` | Real cause→effect chain |
| Orogeny: CC ranges, OC arc + offshore trench, rifts, passive shelf | `pipeline/orogeny.ts` | Correct geomorphic grammar; 8,000 m cap |
| fBm relief + **hydraulic erosion pass** | `pipeline/terrainDetail.ts` | Weathering exists — but one short pass, invisible as a story |
| Lapse rate 6.5 °C/km, latitude gradient, continentality, ocean thermal inertia | `pipeline/seasonalClimate.ts` | Defensible Phase-1 Earth analogue |
| Axial tilt genuinely scales seasonal amplitude | `computeSeasonalClimate` (`seasonScale`) | Real, not cosmetic |
| ITCZ / subtropical-dry / storm-track precip bands + orographic march + foehn | `latitudePrecip`, `marchPrecipitation` | Real pattern grammar |
| Sink-filled D8 flow accumulation, moisture-weighted runoff → rivers | `pipeline/hydrology.ts` | Real hydrology |
| Biomes from (tempMean, tempRange, moisture) + alpine/wetland/mangrove refinement | `pipeline/biomes.ts` | Honest classifier |
| Settlement suitability from biome, climate comfort, rivers, coasts, hazards | `pipeline/suitability.ts` | Reasonable |
| Trade: Dijkstra pathfinding over terrain cost + gravity model volumes | `sketch/polities.ts` (`buildRoutes`, `pairVolume`) | Better than it presents itself |

### What is faked or absent (what a geographer flags first)

1. **Uniform west wind at all latitudes** — rain shadows fall on the wrong side in the tropics (should be east-facing wet under trade easterlies). The code itself plans "Phase 2: latitude-band wind profiles."
2. **Planet radius stops at the plates** — `plates.ts` genuinely uses `planetRadiusKm` (haversine Voronoi via `cellDistanceKm`), but climate discards it (`_planetRadiusKm`), continentality (`bfsDistanceFromSea`) and orogeny Gaussian widths are cell-based. A small planet and a giant one get identical climates.
3. **No kilometres anywhere in the UI** — distances (routes, cell size, river lengths) are in cells. The "real science" claim needs units.
4. **No ocean currents / heat transport** — `oceanClass.ts` is cosmetic (SST + land proximity only); no warm western boundary currents, no cold upwelling → fog deserts and mild NW-Europe analogues can't emerge.
5. **Snapshot tectonics** — uplift uses fixed peak constants regardless of plate relative velocity or age; fast and slow collisions build identical ranges.
6. **No lakes or endorheic basins** — sink-fill guarantees every drop reaches the coast; no Caspians, no Dead Seas.
7. **Weathering is invisible** — the hydraulic erosion loop (`terrainDetail.ts`, 14 iterations) runs once inside orogeny, uncoupled from climate; the user never sees "this valley was carved." The brand promise is literally hidden in a helper function.
8. **No monsoon / seasonal ITCZ shift** — winter precipitation is just summer × 0.5; the ITCZ never migrates, so South-Asia-type climates are impossible.
9. **Biomes by threshold, not water balance** — Köppen-ish rules on temp/moisture instead of a simple PET (Thornthwaite/Budyko) balance; borderline steppe/desert calls are heuristic.
10. **No glaciation** — ice is a biome label, not a process (no U-valleys, fjords, moraines, albedo feedback).

---

## 4. Worldbuild audit — the weakest layer, but partly a *presentation* failure

Claims checked against code:

| Complaint | Reality in code | Verdict |
| --- | --- | --- |
| "Uneditable city names" | Country, people, **and town names are editable** (`.place-name` inputs, `RENAME_PLACE` in `ui.ts` → `shell.ts`) — but only in a side-panel list | **Discoverability failure**: rename must live on the map |
| "Can't zoom in" | Wheel-zoom + space-pan + reset exist (`zoomAtlasAt`, `shell.ts:1024`) | Exists but (a) undocumented (now in Keys sheet), (b) **zoom reveals nothing new** — same raster, blurrier |
| "Trade routes poor" | Real Dijkstra + gravity model, trace/cut tools | Model is fine; **numbers are hidden** — captions say "Caravan: grain, A → B" with no distance, time, or reasoning |
| "No distances" | Correct — nothing is ever expressed in km | Real gap |
| "No reference pictures" | `analogStills.ts` renders 3-band abstract SVGs | Real gap — placeholders, not references |

---

## 5. The plan

### P0 — Ship the identity (days) — largely done, finish the tail
- [x] Solid paper instrument panels, ink text, tone-coded coach
- [x] Cartouche plate (world facts at a glance), mono data type
- [x] Narrated, deliberately-paced Make sense reveal
- [x] Keys reference sheet (incl. Scroll = zoom)
- [x] Palette v2 (iron-oxide + verdigris, ink authority, square action buttons)
- [x] Paper grain + engraved rules on panels (CSS only)

### P1 — Make Worldbuild feel authored (1–2 weeks)
- [x] **Rename in place**: town map labels are contentEditable at zoom; fires `RENAME_PLACE`. Side list still works as backup.
- [x] **Route dossier**: inspector shows km + travel days + writer/auto “why” via `routeDossier` (when Caravans/Sea lanes overlay is on).
- [x] **Scale bar** on the atlas (zoom-aware, next to cartouche).
- [x] **City dossier**: role, port, population band, trade partners in inspector.
- [x] **Reference stills v2**: richer procedural SVG scenes per analog.

### P2 — Zoom that reveals (1–2 weeks)
- **Re-bake on zoom**: `draw.ts` already rasterises from continuous fields; re-render the visible window at screen DPI when zoom > ~1.5× instead of scaling one baked image.
- **Zoom-dependent labels**: towns and country names appear as you zoom; physical features (ranges, big rivers, bays) get auto-generated names at high zoom.
- **Inspect follows zoom**: cell inspector highlights the hovered cell footprint with its km dimensions.

### P3 — Science phase-2 (the geographer's list, in order)
1. Latitude wind belts (trades / westerlies / polar easterlies) in `marchPrecipitation` → correct rain shadows per latitude. Already anticipated in `seasonalClimate.ts` comments.
2. Planet radius into the physics: scale `bfsDistanceFromSea` continentality and orogeny Gaussian radii by km-per-cell (plates already do this via `cellDistanceKm`); expose km everywhere in UI.
3. Lakes & endorheic basins: cap sink-fill depth; deep closed basins become lakes/salt flats.
4. Ocean current approximation: warm poleward western boundaries, cold equatorward eastern boundaries → bias coastal SST/moisture; enables fog deserts and mild west coasts.
5. **Visible weathering**: run the erosion pass as a narrated step ("carving valleys — 40 million years") and show before/after in provenance. This is the brand moment.
6. Velocity-coupled tectonics: scale uplift peaks by plate relative speed instead of fixed constants — fast collisions build higher, sharper ranges.
7. Monsoon: shift the ITCZ with season/obliquity instead of the flat winter × 0.5 scale; seasonal wind flip beside warm ocean.
8. Biomes from a simple water balance (PET via Thornthwaite/Budyko) rather than raw moisture thresholds.
9. Glaciation: ice-sheet mask above a temperature line; fjords + U-valleys on formerly glaciated coasts.

### P4 — Worldbuild simulation depth (later)
- Population & growth from suitability; towns that *earn* their size.
- Route network effects: entrepôts emerge where routes cross; piracy/banditry risk from distance to power.
- History pass: founding dates, ruins, old borders — "weathering" applied to the human layer too.

---

## 6. Prototype memory & cost budget (runs on this laptop)

The default grid is 768×384 = ~295k cells. Budgets below are what the code holds at once; the rule is **one reusable buffer per job, nothing cached per zoom level**.

| Allocation | Size | Policy |
| --- | --- | --- |
| World fields (~14 Float32Arrays + biome labels + rivers) | ~20 MB | One world at a time; old world garbage-collected on re-ground |
| Atlas bake (`ATLAS_CELL_SCALE` 4× dev) + blit scratch | ~38 MB dev / ~12 MB prod (1.5M px cap) | One cached bake per world (`WeakMap`), re-baked on layer/season switch — CPU over RAM |
| Zoom window bake + overlay canvas | ≤ 2 × 7.2 MB (1.8M px cap) | Single reusable canvas; hidden and re-baked per gesture, never cached per level |
| Globe textures (bump/normal/displacement/roughness/color) | ~24 MB | Lazy: only after the writer opens Planet view |
| Mask history snapshots | ~1.2 MB each, capped stack | Undo depth stays bounded |
| Wonders / routes / polities | < 1 MB | Plain arrays, memoised per world (`WeakMap`) |
| Reference stills | ~2 KB each ×12 | Procedural data-URIs, no image fetches |

**Ceiling: ~120 MB working set in dev, ~60 MB in prod** — comfortable for an older MacBook. Guardrails already in code: `ATLAS_PROD_MAX_PIXELS`, `ZOOM_MAX_PIXELS`, preview bakes at 1×, HD bakes deferred to idle, single make-sense worker, no `loadWorld()` on boot.

Cost: everything is client-side and deterministic — no API calls, no model inference, no server. The only budget that matters is the user's CPU/RAM, and both are capped above.

## 7. What "optimized" looks like (success measures)

- A cold user, in one session, ships a world and can answer: *why is this desert here?* (provenance), *how far is A from B?* (km + days), *what does this coast look like?* (reference still).
- Every number shown has a unit; every unit traces to planet radius.
- Screenshot test: a frame of the atlas + cartouche is mistakable for a scanned survey plate.
- No feature that exists is invisible: rename, zoom, routes, seasons all discoverable within the surface they act on.
