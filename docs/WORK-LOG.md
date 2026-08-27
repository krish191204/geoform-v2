# Geoform work log / agent handoff

_Purpose: if this session dies or the model switches, the next agent resumes from here. Keep this file updated after every completed task._

## Mission context

- Product plan lives in `docs/product-plan.md` (mission, palette verdict, science audit, P0–P4 roadmap). Read it first.
- Workspace rule: geographical accuracy first; never mutate `input.mask`; pipeline modules must not import `src/world/` or `src/app/`; no `--prod` deploys; visual target is Geoform 1 (paper-ink atlas). Map look work is gated by `.agents/skills/geoform-atlas-look/SKILL.md`.
- Dev server: `npx vite --port 5199 --strictPort` (needs `required_permissions: ["all"]` in sandbox). Tests: `npx vitest run`, types: `npx tsc --noEmit`.

## Completed (27 Aug, ~14:55)

- **Draggable coach**: grip handle on `#coach`; drag floats it over the map (`position: fixed` on `.app`); double-click docks it back. Tone updates no longer wipe floating state. Keys sheet notes the gesture. Test in `ui.test.ts`.

## Completed (27 Aug, ~15:24)

- **Never show the pipeline in the UI.** Inspector no longer lists Freeze intent / Plates / … under Coach (that list was showing through the translucent coach card). Loading overlay is just “Grounding the doodle…”. Geography still runs the seven steps; they are not writer-facing. Coach card is opaque paper so nothing can bleed through again.
- **Coach resize**: left edge / bottom / corner grips; size persisted at `geoform:coachSize:v1`. Double-click an edge resets.
- **Wonder Earth cousins**: each natural wonder names a real place that formed the same way, picked by hemisphere/latitude (`earthCousinFor` in `wonders.ts`). Shown in the worldbuild list, inspector, and map-label title.

## Completed (27 Aug, ~15:20)

- **Make-sense "Invalid array length"**: not geography. Pipeline finished; `growPolities` Dijkstra stored dist in Float32Array. Heap keys are float64, so past cost ~17 the 1e-6 stale-entry check never settles and `Array.push` throws. Same fix already used in `dijkstraPath`: Float64Array + visit cap. `landStepCost` now returns a finite ≥1 cost. Test: 768×384 × 12 seats + NaN elev.

## Completed (this session, 27 Aug 2026)

1. Frontend rework "cartographer's drafting table": solid paper instrument panels, tone-coded coach borders, Fraunces/Spline Sans Mono, cartouche plate on map (`mountMapShell`/`updateMapShell` in `src/app/ui.ts`), Keys shortcut sheet (incl. "Scroll = zoom the atlas"), narrated paced Make-sense reveal (`GROUND_REVEAL_MIN_MS` in `src/app/shell.ts`).
2. `docs/product-plan.md` written and updated with subagent science audit (wind belts, km scaling, ITCZ shift, velocity tectonics, PET biomes, glaciation gaps).
3. All tests green as of last run; `ui.test.ts` 23 passed.

## In flight (check before redoing!)

- **None.** Climate upgrade + wonders module both landed and are integrated (see “~13:50” and “~14:35” blocks below). Do not re-implement.

## Completed since (same day, later)

- Worldbuild panel de-overload: compact polity cards with dossier chips (`.polity-dossier` in ui.ts/style.css), trimmed city blurbs (no coords/analog).
- km everywhere: `kmPerCell` + `routeLengthKm` (+lat-corrected) in polities.ts; `routeCaption` now appends "· 1,240 km · 42 d"; cartouche shows cell size.
- River rendering: `riverInk` returns {ink, stem}; tapered width (0.08+0.18·stem), stem-scaled alpha (0.45+0.3·stem), lighter tributary color; draw.test threshold retuned (14).
- Zoom populating: `bakeWorldWindowImageData` (draw.ts, pure window bake); shell `scheduleZoomBake`/`runZoomBake` (debounced 200 ms, ≤1.8M px, reusable `map.zoomCanvas`), `updateMapLabels` (label tiers: seats ≥1.35×, ports/trade ≥2.1×, all ≥3×; wonder marks ✦); `paintCities`/`paintWorldOverlay` exported from atlas.ts and repainted over the HD window.
- `APP_EVENTS.GOTO_CELL` + `GotoCellDetail`; wonders list in worldbuild panel (`.wonder-goto` buttons) pans/zooms the atlas to the wonder.
- City dossier in inspector: `.town-dossier` (role/port headline, `populationBand` from suitability, "Trades with …" from routes); wonder-at-cell line.
- `src/app/wondersCache.ts`: WeakMap memo of `findWonders`, guards partial fixture worlds.
- Reference stills v2: analogStills.ts rewritten — layered scenes (sky gradient, two ridgelines, haze, per-analog feature: trees/palms/dunes/water/ice/fields/mesa/reeds). Caption constant unchanged.
- Prototype memory/cost budget section added to docs/product-plan.md (§6).
- Tests green except full-pipeline-dependent ones while the climate subagent edits seasonalClimate (see In flight).

## Completed (27 Aug, ~13:50 — post-subagent integration)

- **Both subagents landed.** Climate: `seasonalClimate.ts` now has latitude wind bands (`rowWindDir`: trades <30° dir −1, westerlies 30–60° dir +1, polar easterlies dir −1), seasonal ITCZ shift (±8°×obliquity in `latitudePrecip`), km continentality (`COASTALITY_SCALE_KM=1500`). Wonders: `src/sketch/wonders.ts` + tests, working in UI.
- **Wind-band test fixes (by main agent).** Old tests assumed westerlies everywhere:
  - `donald-minimum.test.ts` "windward > lee" — sampled band (rows 0.35h–0.65h) is TRADES, so windward = EAST face. Flipped assertion (`eastMean > westMean`), renamed to "tropical N-S ridge".
  - `donald-climate.test.ts` both rain-shadow tests — now compute `dir = rowWindDir(latRad(y,h))` per row; windward = upstream (x−dir·dx). Imports `rowWindDir` + `latRad`.
  - `src/critique/analyzeWorld.ts` `checkRainShadow` — was hardcoded west-wind; now band-aware per row (same `rowWindDir` import). Critique message updated.
  - `src/critique/main.test.ts` "flags flipped rain shadow" fixture moved cy 10→11: latRad(10,16) is EXACTLY −30° and float error dropped it into the trades; row 11 = −42°, solidly westerlies.
- **Real bug found & fixed: `dijkstraPath` in polities.ts used `Float32Array` for `dist` while heap keys are float64.** Beyond path cost ~17, float32 rounding of stored dist exceeds the 1e-6 stale-entry tolerance → live heap entries discarded → route search fragments → `traceTradeRoute` returns null on long/expensive paths. Fixed: `dist` is now `Float64Array` (comment in code). This was user-visible (route tracing would silently fail).
- `polities.test.ts` caravan test: endpoint pick was manhattan-distance and could land on a disconnected islet; now BFS-picks b on the SAME land component (6–18 steps).
- **Full suite green: 42 files, 491 tests, tsc clean** (13:46 local).
- Browser verified: wonders panel w/ mechanism blurbs + futures; wonder "go to" pans+zooms; zoom populating (HD window bake + tiered labels + ✦ marks) works; city dossier in inspector ("Quenminster — pastoral town, sea port, ≈9,500 people"); cartouche shows Cell ≈52 km; moisture layer shows wet coasts/dry interior + latitude bands. Note: vite HMR resets in-memory world when src files change — repaint+re-ground to test.

## Completed (27 Aug, ~13:55) — Palette v2 IMPLEMENTED

- `src/style.css` root: `--copper` → `#a04a22` (iron-oxide, irreversible acts only), added `--verdigris: #4a7a6a` (derived-world facts), added `--grain` (inline SVG turbulence data-URI).
- Base `button, .select-like` radius 999px → 8px (chips/pills keep their own 999px rules). `button.primary:hover` → `#8a3d1b`.
- Appended block at end of style.css: grain + engraved double-rule inset frame on `.tools-panel/.inspector/.keys-card/.loading-card` (echoes cartouche); verdigris on `.cartouche-data dd`, `.dossier-land`, `.town-head`.
- ui tests still 23/23. NOT visually verified — browser MCP dropped. Next agent: load :5199 and eyeball; risk is low (CSS vars only).

## Completed (27 Aug, ~14:35) — P1 authored worldbuild

- **Scale bar**: `map.scaleBar` in plate dock; `niceScaleKm()` in `ui.ts`; `updateScaleBar()` in `shell.ts` from `applyAtlasView` (zoom-aware). Hidden on sketch / planet / mobile.
- **Rename-in-place**: town labels at zoom are `contentEditable`; Enter commits, Esc cancels; fires `APP_EVENTS.RENAME_PLACE`; `updateMapLabels()` after rename. Side panel still works.
- **Route dossier**: new `routeDossier()` in `polities.ts` — caption + writer/auto why + pace. Inspector uses it when Caravans/Sea lanes overlay is active.
- **Wonder fjord copy**: `shoreFeel(temp)` replaces “cold ${band} shore” so −11°C is not “cold subtropical”.
- Tests: ui 24, polities 9, wonders 8; `tsc` clean.

## TODO queue (remaining for next agent)

1. Visual pass: palette v2 + rivers at zoom ≥2 + scale bar + rename labels (browser MCP flaky; load `http://localhost:5199`).
2. Country rename-in-place on map (towns done; countries still side-panel only).
3. P2 leftovers: auto-named ranges/bays at high zoom (optional).
4. P3/P4 science & simulation depth — see `docs/product-plan.md`.
5. Do **not** re-do completed climate/wonders/zoom/rivers/dijkstra Float64 fix — already landed.

## Resume checklist (next model)

```bash
# handoff read
cat docs/WORK-LOG.md docs/product-plan.md | head -200
npx vite --port 5199 --strictPort   # needs unrestricted perms in sandbox
npx vitest run && npx tsc --noEmit
```

Key recent files: `src/app/shell.ts` (zoom, labels, scale, inspect), `src/app/ui.ts` (chrome, `niceScaleKm`), `src/sketch/polities.ts` (`routeDossier`, Float64 Dijkstra), `src/pipeline/seasonalClimate.ts` (wind belts), `src/sketch/wonders.ts`, `src/style.css` (palette v2), `src/render/draw.ts` (rivers + window bake).

## Old TODO queue (remaining)

1. Visual pass on palette v2 + rivers at zoom ≥2 (browser bridge died before the screenshot; all code landed, tests green).
2. Optional polish: wonder blurb "cold subtropical shore (mean −11 °C)" — **DONE** via `shoreFeel`.
3. P1 items: rename / route dossier / scale — **DONE** (this block). P4 simulation depth untouched.

## Old TODO queue (all done except palette v2 — kept for context)

1. **Worldbuild panel information overload** (user screenshot: cramped two-column COUNTRY/PEOPLE list with dossier text wrapping badly). Redesign in `src/app/ui.ts` (worldbuild work panel) + `src/style.css`: one compact card per polity — name input inline in header, people input under it, dossier compressed to short tag-like rows (Landscape / Exports / Wants), long prose behind `<details>`. Don't break `RENAME_PLACE` event wiring or polities tests.
2. **km everywhere**: `kmPerCell = 2π·meta.planetRadiusKm / meta.width`. Add scale bar on atlas (DOM overlay near cartouche, shows e.g. "500 km" sized to current zoom), route captions gain km + travel days (caravan ~30 km/day, ship ~120 km/day) — extend `routeCaption` in `src/sketch/polities.ts` (path length × kmPerCell, remember `wrapDx`), cartouche shows cell size.
3. **City dossier**: inspector view for a hovered/clicked city — role, port, polity, exports/imports (`economyLine`), population band from suitability. Wire into inspect tool path in `shell.ts`.
4. **Zoom populating (user: MUST be done)**: when zoomed in, re-bake the visible window at higher pixel density instead of scaling the baked raster, and make town labels appear at zoom. Current state: `zoomAtlasAt` in `shell.ts` (~line 341) sets a CSS transform on `map.canvas`; wheel handler ~line 1024. `draw.ts` is pure and can rasterise any scale via `bakeWorldImageDataSmooth` (whole world) — for a window bake you likely need a new pure fn `bakeWorldWindow(world, season, layer, cellRect, outW, outH)` reusing `sampleBilinear`/`applyPaperLook` (export or refactor them), then in `atlas.ts`/`shell.ts` debounce ~180 ms after zoom settles and swap the canvas content. MEMORY BUDGET: single reusable offscreen canvas ≤ 2048×2048 (~16 MB), no per-zoom allocations, bail to CSS scaling while animating. Labels: DOM overlay div positioned via the same transform math; towns show names when zoom ≥ ~1.8, wonders markers too.
5. **Rivers look bad** (user complaint). Renderer is `riverInk` in `src/render/draw.ts` (~line 403): per-pixel distance to the cell→downhill segment, width from log flux. Suspected issues: (a) stub dots at local maxima (down < 0 draws a point blob), (b) zigzag because only the downstream half-segment of each cell is inked — no upstream continuity, (c) too dark/thick at low bake scale. Fix within the skill's rules (pure draw, bilinear look): skip local-max cells with flux < RIVER_MAIN; also ink the segment from each river cell's upstream river neighbour(s) for continuity; taper: `half = 0.07 + 0.18*stem`; lighten small streams toward [70,105,125]; make sure the atlas bakes ≥4 px/cell (check `atlasBakeWidth` in `src/app/atlas.ts`) so strokes resolve. Verify against Geoform 1 look (fine engraved drainage, not fat squiggles).
6. **Wonders UI**: after wonders subagent lands, add a Wonders section (worldbuild inspector or map dock): list with name/kind/blurb/futures, click → pan/zoom atlas to location (reuse `zoomAtlasAt` math). Show as small markers on the map overlay at zoom (DOM, not baked into raster).
7. **Reference stills v2**: `src/app/analogStills.ts` currently 3-band SVGs. Replace with richer layered procedural SVG scenes per `PlaceAnalogId` (ridgeline silhouettes, sky gradient, weather hint, 3–4 layers, still cheap data-URIs). Keep `ANALOG_STILL_CAPTION` verbatim (tests may pin it).
8. **Prototype memory/cost budget**: add section to `docs/product-plan.md`. Budgets to write down: world fields ≈ 15 Float32Arrays × W·H (256×144 ≈ 37k cells ≈ 2.2 MB total); atlas bake canvas ≤ 2048² RGBA ≈ 16 MB; one reusable zoom-window canvas same cap; history snapshots capped (check `src/world/history.ts` cap); no `loadWorld()` on boot; single make-sense worker; stills are data-URIs (<5 KB each). Target: whole app < 150 MB heap on an older MacBook (darwin 21.6 ≈ macOS 12 era).
9. **Verify**: `npx vitest run`, `npx tsc --noEmit`, browser pass at :5199 (paint land → Make sense → check rivers/zoom/labels/panel).

## Key file map

- `src/app/shell.ts` — state machine, atlas view transform (`zoomAtlasAt` ~341, wheel ~1024), runMakeSense pacing, inspect wiring.
- `src/app/ui.ts` — all chrome/panels; worldbuild work panel builds the COUNTRY/PEOPLE list; `KEYS_GENERAL`, cartouche, loading narration (`MAKE_SENSE_STEP_GLOSS`).
- `src/app/atlas.ts` — bake scheduling, `atlasBakeWidth`, sketch note painting.
- `src/render/draw.ts` — pure rasteriser; `riverInk`, `applyPaperLook`, `bakeWorldImageDataSmooth`, `sampleBilinear`.
- `src/sketch/polities.ts` — cities/routes/economy; `routeCaption` (line ~623), `buildRoutes` (Dijkstra + gravity).
- `src/app/analogStills.ts` — reference stills.
- `src/style.css` — all styling; solid `--card` panels, cartouche, loading, keys sheet.

## User's standing directives

- Identity: "weathering + making your world look realistic based on real science". Palette v2 direction (iron-oxide accent, verdigris secondary, ink authority, fewer pills) approved in plan but NOT yet implemented — do after functional items.
- Wonders/"alien places" are a major draw — priority feature.
- Zoom populating is a must.
- Everything must run comfortably on the user's laptop — memory-budgeted, cost-effective.
- Science: update "faked and absent" items without disrupting what works (wind belts subagent is that).
