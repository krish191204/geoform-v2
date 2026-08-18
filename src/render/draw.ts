/**
 * Atlas renderer for the mask-first World.
 *
 * Two public surfaces, both pure functions (no globals, no hidden state):
 *
 *   - `draw(world, season, layer, options?)` -> ImageData
 *       Rasterises the chosen layer to an `ImageData` the caller can
 *       `putImageData` onto any canvas. `season` selects which seasonal
 *       field (`summer`/`winter` for temperature, `summerMoist`/`winterMoist`
 *       for moisture) the active layer reads.
 *
 *   - `inspectCell(world, x, y)` -> CellInspectorView
 *       Returns every field the inspector binds to a cell, with a
 *       `display` block pre-formatted for the panel. Missing or NaN
 *       fields render as the em-dash "—" — never an orphan number.
 *
 * Every layer reads a real field on `World`; no decorative look-ups,
 * no cached aggregates masquerading as fresh data.
 */
import { biomeColor, type Layer, type World } from '../world/types'

// ---------------------------------------------------------------------------
// 1. Types
// ---------------------------------------------------------------------------

/** Which half of the seasonal year the renderer is sampling. */
export type Season = 'summer' | 'winter'

/** One render call's tunables. All optional. */
export interface DrawOptions {
  /** Up-sample factor (1 = native cell size). */
  scale?: number
  /** Overlay rivers on the Relief layer. Defaults to true. */
  showRivers?: boolean
  /** Bilinear sample when scale > 1 (continuous layers). */
  smooth?: boolean
  /** Stamp city dots into the bitmap (globe textures). Atlas overlays instead. */
  bakeCities?: boolean
}

/** Every field the inspector binds to a single cell, plus display strings. */
export interface CellInspectorView {
  /** Elevation in metres. */
  elev: number | undefined
  /** Tectonic plate id. */
  plateId: number | undefined
  /** Warm-half mean temperature, °C. */
  tempSummer: number | undefined
  /** Cold-half mean temperature, °C. */
  tempWinter: number | undefined
  /** Annual temperature swing (summer − winter), °C. */
  tempRange: number | undefined
  /** Warm-half precipitation index, 0..1. */
  moistSummer: number | undefined
  /** Cold-half precipitation index, 0..1. */
  moistWinter: number | undefined
  /** Per-cell biome name. */
  biome: string
  /** Pre-formatted strings; every entry is "—" if the underlying field is missing. */
  display: {
    elev: string
    plateId: string
    tempSummer: string
    tempWinter: string
    tempRange: string
    moistSummer: string
    moistWinter: string
    biome: string
  }
}

// ---------------------------------------------------------------------------
// 2. Inspector
// ---------------------------------------------------------------------------

/**
 * A raw number is "defined" if the cell actually holds one. NaN counts
 * as defined (the array is populated); the display formatters are the
 * ones that flag NaN with the em-dash.
 */
function isDefined(v: number | undefined): v is number {
  return v !== undefined
}

function fmtMeters(v: number | undefined): string {
  return v !== undefined && Number.isFinite(v) ? `${Math.round(v)} m` : '—'
}

function fmtCelsius(v: number | undefined): string {
  return v !== undefined && Number.isFinite(v) ? `${Math.round(v)}°C` : '—'
}

function fmtMoist(v: number | undefined): string {
  return v !== undefined && Number.isFinite(v) ? `${v.toFixed(2)} · 0–1` : '—'
}

function fmtPlateId(v: number | undefined): string {
  return v !== undefined && Number.isFinite(v) ? String(v) : '—'
}

/**
 * Read every per-cell field the inspector binds. Raw numeric fields are
 * returned as-is so a future panel can switch units without re-reading
 * the array. The `display` block carries the user-facing strings; every
 * entry is the em-dash "—" when the underlying field is undefined OR
 * NaN. No orphan metrics — only fields the World actually owns.
 */
export function inspectCell(world: World, x: number, y: number): CellInspectorView {
  const { meta, elev, plateId, summer, winter, tempRange, summerMoist, winterMoist, biome } = world
  const { width } = meta
  const i = y * width + x
  const e = elev[i]
  const pid = plateId[i]
  const ts = summer[i]
  const tw = winter[i]
  const tr = Number.isFinite(ts) && Number.isFinite(tw) ? ts - tw : tempRange[i]
  const ms = summerMoist[i]
  const mw = winterMoist[i]
  const b = typeof biome[i] === 'string' && biome[i].length > 0 ? biome[i] : undefined
  const rangeLabel =
    Number.isFinite(ts) && Number.isFinite(tw)
      ? `${Math.round(ts) - Math.round(tw)}°C`
      : fmtCelsius(tr)

  return {
    elev: isDefined(e) ? e : undefined,
    plateId: isDefined(pid) ? pid : undefined,
    tempSummer: isDefined(ts) ? ts : undefined,
    tempWinter: isDefined(tw) ? tw : undefined,
    tempRange: isDefined(tr) ? tr : undefined,
    moistSummer: isDefined(ms) ? ms : undefined,
    moistWinter: isDefined(mw) ? mw : undefined,
    biome: b ?? '—',
    display: {
      elev: fmtMeters(e),
      plateId: fmtPlateId(pid),
      tempSummer: fmtCelsius(ts),
      tempWinter: fmtCelsius(tw),
      tempRange: rangeLabel,
      moistSummer: fmtMoist(ms),
      moistWinter: fmtMoist(mw),
      biome: b ?? '—',
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Colour primitives
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(v: number, lo = 0, hi = 255): number {
  return v < lo ? lo : v > hi ? hi : v
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/**
 * Normalise a 0..1 ramp parameter into the [0, 1] range.
 * NaN-safe: returns 0 for undefined or non-finite inputs.
 */
function ramp(v: number | undefined): number {
  if (!Number.isFinite(v as number)) return 0
  if ((v as number) < 0) return 0
  if ((v as number) > 1) return 1
  return v as number
}

// ---------------------------------------------------------------------------
// 4. Per-layer colour ramps
// ---------------------------------------------------------------------------

/**
 * Banded elevation ramp in metres. Ocean is the mask, not `meta.seaLevel`
 * (that field is a 0..1 freeze threshold leftover and would paint every
 * 200 m plain as snow).
 */
function elevBandColor(e: number, ocean: boolean): [number, number, number] {
  if (!Number.isFinite(e)) return [120, 120, 120]
  if (ocean) {
    // Pipeline abyssal default is 0 m; trenches go negative. Keep the shelf
    // legible without turning an unmeasured 0 m ocean into tropical shallows.
    const shelf = e >= 0 ? 0.3 : ramp((e + 2200) / 2200) * 0.3
    return mix([7, 25, 45], [22, 67, 91], shelf)
  }
  if (e < 80) return mix([154, 158, 108], [100, 133, 76], ramp(e / 80))
  if (e < 400) return mix([100, 133, 76], [66, 110, 62], (e - 80) / 320)
  if (e < 1200) return mix([66, 110, 62], [105, 112, 69], (e - 400) / 800)
  if (e < 2500) return mix([105, 112, 69], [130, 108, 82], (e - 1200) / 1300)
  if (e < 5000) return mix([130, 108, 82], [174, 164, 146], (e - 2500) / 2500)
  return mix([174, 164, 146], [235, 234, 225], ramp((e - 5000) / 3000))
}

function isOceanCell(world: World, i: number): boolean {
  return world.mask[i] < world.meta.threshold
}

/**
 * Temperature ramp: blue → red, keyed off °C.
 * −45 °C saturates blue, +38 °C saturates red.
 */
function tempColor(c: number): [number, number, number] {
  const t = ramp((c + 45) / 83)
  if (t < 0.33) return mix([40, 70, 170], [70, 160, 170], t / 0.33)
  if (t < 0.66) return mix([70, 160, 170], [210, 170, 70], (t - 0.33) / 0.33)
  return mix([210, 170, 70], [200, 70, 40], (t - 0.66) / 0.34)
}

/**
 * Moisture ramp: dry → wet. Expects a 0..1 input.
 */
function moistureColor(m: number): [number, number, number] {
  // Sand only for true aridity — Geoform 1 recipe; mid values read as grassland.
  const t = ramp(m)
  if (t < 0.18) return mix([196, 150, 88], [170, 140, 70], t / 0.18)
  if (t < 0.45) return mix([170, 140, 70], [70, 130, 90], (t - 0.18) / 0.27)
  return mix([70, 130, 90], [30, 100, 140], (t - 0.45) / 0.55)
}

/**
 * Suitability ramp: hostile → hospitable. The new `World` does not carry
 * an explicit per-cell suitability score, so this layer visualises the
 * annual mean precipitation (`moistMean`) — the closest honest field.
 */
function suitColor(s: number): [number, number, number] {
  const t = ramp(s)
  if (t < 0.28) return mix([120, 48, 40], [150, 70, 38], t / 0.28)
  if (t < 0.52) return mix([150, 70, 38], [170, 150, 50], (t - 0.28) / 0.24)
  return mix([170, 150, 50], [50, 140, 70], (t - 0.52) / 0.48)
}

/** Twelve-entry discrete plate palette — one entry per plate id. */
const PLATE_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [214, 106, 72],
  [72, 148, 140],
  [196, 150, 70],
  [110, 120, 170],
  [150, 100, 120],
  [90, 140, 90],
  [180, 120, 90],
  [100, 160, 180],
  [170, 90, 90],
  [130, 130, 90],
  [90, 110, 140],
  [160, 140, 110],
]

function plateColor(pid: number): [number, number, number] {
  if (!Number.isFinite(pid)) return [80, 80, 80]
  const len = PLATE_PALETTE.length
  const p = ((Math.trunc(pid) % len) + len) % len
  const entry = PLATE_PALETTE[p]
  return [entry[0], entry[1], entry[2]]
}

// ---------------------------------------------------------------------------
// 5. Coastal & sampling helpers
// ---------------------------------------------------------------------------

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function maskAt(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const cx = wrapX(x, w)
  const cy = Math.max(0, Math.min(h - 1, y))
  return world.mask[cy * w + cx]
}

/** Bilinear elevation so globe bump/displacement is not a voxel lattice. */
function sampleElev(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const x0 = wrapX(Math.floor(x), w)
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = wrapX(x0 + 1, w)
  const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
  const fx = x - Math.floor(x)
  const fy = y - Math.floor(y)
  const e00 = world.elev[y0 * w + x0]
  const e10 = world.elev[y0 * w + x1]
  const e01 = world.elev[y1 * w + x0]
  const e11 = world.elev[y1 * w + x1]
  return lerp(lerp(e00, e10, fx), lerp(e01, e11, fx), fy)
}

function sampleMask(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const x0 = wrapX(Math.floor(x), w)
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = wrapX(x0 + 1, w)
  const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
  const fx = x - Math.floor(x)
  const fy = y - Math.floor(y)
  return lerp(
    lerp(maskAt(world, x0, y0), maskAt(world, x1, y0), fx),
    lerp(maskAt(world, x0, y1), maskAt(world, x1, y1), fx),
    fy,
  )
}

/** Characteristic relief scales in metres: local ridges plus broad landforms. */
const LOCAL_SHADE_M = 1250
const BROAD_SHADE_M = 5200
/** Flux above this tints as a tributary (matches hydrology river cutoff). */
const RIVER_VISIBLE = 8
/** Flux above this tints as a main stem. */
const RIVER_MAIN = 24

function plateBoundaryCue(
  world: World,
  x: number,
  y: number,
): { edge: boolean; approach: number } {
  const { width: w, height: h } = world.meta
  const i = y * w + x
  const p = world.plateId[i]
  const vx = world.plateVx[i] ?? 0
  const vy = world.plateVy[i] ?? 0
  let edge = false
  let approach = 0
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = wrapX(x + dx, w)
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    const ni = ny * w + nx
    if (world.plateId[ni] === p) continue
    edge = true
    const qx = world.plateVx[ni] ?? 0
    const qy = world.plateVy[ni] ?? 0
    const len = Math.hypot(dx, dy) || 1
    approach = Math.max(approach, -((vx - qx) * dx + (vy - qy) * dy) / len)
  }
  return { edge, approach }
}

function isCoast(world: World, x: number, y: number): boolean {
  const { width: w, height: h } = world.meta
  if (x < 0 || y < 0 || x >= w || y >= h) return false
  const land = !isOceanCell(world, y * w + x)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const nLand = !isOceanCell(world, ny * w + nx)
      if (nLand !== land) return true
    }
  }
  return false
}

/** How much of the bilinear neighbourhood is a land/sea edge (0..1). */
function coastAmount(world: World, xf: number, yf: number): number {
  const { width: w, height: h } = world.meta
  const x0 = wrapX(Math.floor(xf), w)
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(yf)))
  const x1 = wrapX(x0 + 1, w)
  const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
  let n = 0
  if (isCoast(world, x0, y0)) n++
  if (isCoast(world, x1, y0)) n++
  if (isCoast(world, x0, y1)) n++
  if (isCoast(world, x1, y1)) n++
  return n / 4
}

function sampleScalar(field: ArrayLike<number>, world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const x0 = wrapX(Math.floor(x), w)
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = wrapX(x0 + 1, w)
  const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
  const fx = x - Math.floor(x)
  const fy = y - Math.floor(y)
  const v00 = field[y0 * w + x0]
  const v10 = field[y0 * w + x1]
  const v01 = field[y1 * w + x0]
  const v11 = field[y1 * w + x1]
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy)
}

/** Seeded paper grain — static, centred, and periodic across the date line. */
function paperGrain(x: number, y: number, width: number): number {
  const theta = (wrapX(x, width) / Math.max(1, width)) * Math.PI * 2
  const raw =
    Math.sin(Math.cos(theta) * 19.1398 + Math.sin(theta) * 31.733 + y * 78.233) *
    43758.5453
  return (raw - Math.floor(raw)) * 0.06 - 0.03
}

// ---------------------------------------------------------------------------
// 6. Per-cell colour (pure)
// ---------------------------------------------------------------------------

/**
 * Layer fill only — no hillshade, grain, or coast. Integer cell.
 * Bilinear sampling mixes these, then `applyPaperLook` lights the sample.
 */
function layerFill(
  world: World,
  season: Season,
  layer: Layer,
  x: number,
  y: number,
): [number, number, number] {
  const { width: w, height: h } = world.meta
  if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0]
  const i = y * w + x
  const e = world.elev[i]
  const ocean = isOceanCell(world, i)

  switch (layer) {
    case 'relief':
    case 'elevation':
      return elevBandColor(e, ocean)
    case 'plates': {
      let rgb = plateColor(world.plateId[i])
      if (ocean) {
        rgb = mix(rgb, [20, 50, 70], 0.55)
      } else {
        const above = Math.max(0, e / 8000)
        if (above > 0.08) rgb = mix(rgb, [232, 220, 200], Math.min(0.72, above * 0.95))
      }
      const { edge, approach } = plateBoundaryCue(world, x, y)
      if (edge) {
        rgb = mix(rgb, [18, 22, 28], 0.42)
        if (approach > 0.02) {
          rgb = mix(rgb, [210, 150, 90], Math.min(0.55, 0.22 + approach * 0.9))
        } else if (approach < -0.02) {
          rgb = mix(rgb, [70, 120, 160], Math.min(0.45, 0.18 + -approach * 0.8))
        }
      }
      return rgb
    }
    case 'moisture': {
      const m = season === 'summer' ? world.summerMoist[i] : world.winterMoist[i]
      return ocean ? ([22, 58, 82] as [number, number, number]) : moistureColor(m)
    }
    case 'temperature':
      // Temperature includes ocean (SST). Do not hide climate under a sea fill.
      return tempColor(season === 'summer' ? world.summer[i] : world.winter[i])
    case 'biome':
      // One message: Holdridge class. Hillshade comes later; do not tint deserts green.
      return hexToRgb(biomeColor(world.biome[i] ?? 'ocean'))
    case 'suitability':
      return ocean
        ? mix(suitColor(world.suitability[i]), [18, 48, 68], 0.55)
        : suitColor(world.suitability[i])
  }
}

/**
 * Geoform 1 paper recipe at a sample (integer or fractional).
 * Hillshade reads bilinear elevation so ridges are continuous, not voxel stairs.
 */
function applyPaperLook(
  rgb: [number, number, number],
  world: World,
  layer: Layer,
  x: number,
  y: number,
  showRivers: boolean,
): [number, number, number] {
  const threshold = world.meta.threshold
  const e = sampleElev(world, x, y)
  const ocean = sampleMask(world, x, y) < threshold

  // Hillshade on terrain-ish layers. Height stays a raw metre ramp.
  if (layer === 'relief' || layer === 'biome' || layer === 'plates') {
    const localDx =
      (sampleElev(world, x - 1, y) - sampleElev(world, x + 1, y)) /
      LOCAL_SHADE_M
    const localDy =
      (sampleElev(world, x, y - 1) - sampleElev(world, x, y + 1)) /
      LOCAL_SHADE_M
    const broadDx =
      (sampleElev(world, x - 3, y) - sampleElev(world, x + 3, y)) /
      BROAD_SHADE_M
    const broadDy =
      (sampleElev(world, x, y - 3) - sampleElev(world, x, y + 3)) /
      BROAD_SHADE_M
    const directional =
      localDx * 0.78 + localDy * 0.58 + broadDx * 0.48 + broadDy * 0.34
    const shade = clamp(0.97 + directional, 0.62, 1.24)
    const strength = layer === 'relief' ? 0.94 : layer === 'biome' ? 0.58 : 0.48
    const lit = lerp(1, shade, strength)
    rgb = [clamp(rgb[0] * lit), clamp(rgb[1] * lit), clamp(rgb[2] * lit)]
  }

  // Multi-scale still-water variation. Both frequencies are spatially fixed,
  // so the ocean has depth without animated noise or false bathymetry.
  if (ocean && (layer === 'relief' || layer === 'biome' || layer === 'elevation')) {
    const shelf = e < 0 ? ramp(1 + e / 1800) : 0.28
    const lon = (wrapX(x, world.meta.width) / Math.max(1, world.meta.width)) * Math.PI * 2
    const swell =
      Math.sin(lon * 3 + Math.cos(y * 0.08) * 1.7) *
      Math.sin(y * 0.14 - lon * 0.7)
    const ripple =
      Math.sin(lon * 11 + Math.cos(y * 0.2) * 2.1) *
      Math.sin(y * 0.37 + lon * 1.6)
    const shimmer = (swell * 0.6 + ripple * 0.4) * (0.55 + shelf * 0.45)
    rgb = [
      clamp(rgb[0] + shimmer * 4),
      clamp(rgb[1] + shimmer * 8),
      clamp(rgb[2] + shimmer * 12),
    ]
  }

  // Coastal ink/foam — a narrow transition, not a white halo. Skip plates so
  // tectonic sutures stay readable.
  if (layer !== 'plates') {
    const foam = coastAmount(world, x, y)
    if (foam > 0) {
      rgb = ocean
        ? mix(rgb, [174, 205, 205], 0.16 * foam)
        : mix(rgb, [33, 41, 32], 0.25 * foam)
    }
  }

  // Rivers from flux (tributaries faint, mains brighter) — v1 network look.
  if (showRivers && !ocean && layer !== 'plates' && layer !== 'temperature') {
    const f = sampleScalar(world.flux, world, x, y)
    const riverCoverage = sampleScalar(world.rivers, world, x, y)
    const flagged = riverCoverage >= 0.12
    if (f >= RIVER_VISIBLE || flagged) {
      const isMain = f >= RIVER_MAIN
      const strength = isMain
        ? Math.min(1, (f - RIVER_MAIN) / 40)
        : Math.min(1, Math.max(0, f - RIVER_VISIBLE) / 20)
      const coverage = Math.min(1, riverCoverage * 1.45)
      const t = ((isMain ? 0.58 : flagged ? 0.4 : 0.3) + strength * 0.34) * coverage
      rgb = mix(rgb, isMain ? [39, 105, 157] : [58, 132, 169], Math.min(0.9, t))
    }
  }

  // Micro-texture so flats don't look like solid fill (Geoform 1, every layer).
  const grain = paperGrain(x, y, world.meta.width)
  rgb = [clamp(rgb[0] * (1 + grain)), clamp(rgb[1] * (1 + grain)), clamp(rgb[2] * (1 + grain))]

  return rgb
}

/**
 * Sample one cell's display colour for the active layer + season.
 * Pure: same inputs → same output, no globals, no animation.
 */
function cellColor(
  world: World,
  season: Season,
  layer: Layer,
  x: number,
  y: number,
  showRivers: boolean,
): [number, number, number] {
  return applyPaperLook(layerFill(world, season, layer, x, y), world, layer, x, y, showRivers)
}

// ---------------------------------------------------------------------------
// 7. Pure draw
// ---------------------------------------------------------------------------

/**
 * Rasterise the world for the active layer + season to an `ImageData`.
 * Pure: same inputs → same output, no globals, no DOM, no animation.
 *
 *   draw(world, 'summer', 'temperature')  -> per-cell blue→red ramp
 *   draw(world, 'winter', 'moisture')     -> per-cell dry→wet ramp
 *   draw(world, 'summer', 'biome')        -> per-cell BIOME_COLORS entry
 */
export function draw(
  world: World,
  season: Season,
  layer: Layer,
  options: DrawOptions = {},
): ImageData {
  const { width: w, height: h } = world.meta
  const scale = Math.max(1, Math.floor(options.scale ?? 1))
  const showRivers = options.showRivers ?? layer === 'relief'
  const smooth = options.smooth ?? false
  const bakeCities = options.bakeCities ?? false

  const outW = w * scale
  const outH = h * scale
  const image = new ImageData(outW, outH)
  const data = image.data

  if (scale === 1) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const rgb = cellColor(world, season, layer, x, y, showRivers)
        const o = (y * w + x) * 4
        data[o] = rgb[0]
        data[o + 1] = rgb[1]
        data[o + 2] = rgb[2]
        data[o + 3] = 255
      }
    }
  } else if (smooth && layer !== 'plates') {
    for (let py = 0; py < outH; py++) {
      const yf = (py + 0.5) / scale
      for (let px = 0; px < outW; px++) {
        const xf = (px + 0.5) / scale
        const rgb = sampleBilinear(world, season, layer, xf, yf, showRivers)
        const o = (py * outW + px) * 4
        data[o] = rgb[0]
        data[o + 1] = rgb[1]
        data[o + 2] = rgb[2]
        data[o + 3] = 255
      }
    }
  } else {
    for (let py = 0; py < outH; py++) {
      const sy = Math.min(h - 1, (py / scale) | 0)
      for (let px = 0; px < outW; px++) {
        const sx = Math.min(w - 1, (px / scale) | 0)
        const rgb = cellColor(world, season, layer, sx, sy, showRivers)
        const o = (py * outW + px) * 4
        data[o] = rgb[0]
        data[o + 1] = rgb[1]
        data[o + 2] = rgb[2]
        data[o + 3] = 255
      }
    }
  }

  if (bakeCities) stampCities(image, world, scale)
  applyVignette(image)
  return image
}

function sampleBilinear(
  world: World,
  season: Season,
  layer: Layer,
  xf: number,
  yf: number,
  showRivers: boolean,
): [number, number, number] {
  const { width: w, height: h } = world.meta
  const x0 = wrapX(xf | 0, w)
  const y0 = Math.min(h - 1, yf | 0)
  const x1 = wrapX(x0 + 1, w)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = xf - Math.floor(xf)
  const fy = yf - y0
  const c00 = layerFill(world, season, layer, x0, y0)
  const c10 = layerFill(world, season, layer, x1, y0)
  const c01 = layerFill(world, season, layer, x0, y1)
  const c11 = layerFill(world, season, layer, x1, y1)
  const mixed = mix(mix(c00, c10, fx), mix(c01, c11, fx), fy)
  return applyPaperLook(mixed, world, layer, xf, yf, showRivers)
}

/** Subtle print-edge darkening. CSS provides only the glass highlight. */
export function applyVignette(image: ImageData): void {
  const cw = image.width
  const ch = image.height
  const data = image.data
  for (let py = 0; py < ch; py++) {
    const ny = ((py + 0.5) / ch) * 2 - 1
    for (let px = 0; px < cw; px++) {
      const nx = ((px + 0.5) / cw) * 2 - 1
      const v = Math.min(1, Math.sqrt(nx * nx * 0.7 + ny * ny * 0.95))
      const dark = 1 - v * v * 0.12
      const o = (py * cw + px) * 4
      data[o] = Math.round(data[o] * dark)
      data[o + 1] = Math.round(data[o + 1] * dark)
      data[o + 2] = Math.round(data[o + 2] * dark)
    }
  }
}

function stampCities(image: ImageData, world: World, scale: number): void {
  const { width: w } = world.meta
  const cw = image.width
  const ch = image.height
  const data = image.data
  const r = Math.max(2, Math.round(scale * 0.55))
  for (const c of world.cities) {
    const cx = Math.round((c.x + 0.5) * (cw / w))
    const cy = Math.round((c.y + 0.5) * (ch / world.meta.height))
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue
        const px = cx + dx
        const py = cy + dy
        if (px < 0 || py < 0 || px >= cw || py >= ch) continue
        const o = (py * cw + px) * 4
        data[o] = 245
        data[o + 1] = 236
        data[o + 2] = 214
        data[o + 3] = 255
      }
    }
  }
}

/**
 * High-res bilinear bake for the globe (and a smoother atlas blit).
 * `outW` is texture width; height follows the world's 2:1 aspect.
 */
export function bakeWorldImageDataSmooth(
  world: World,
  season: Season,
  layer: Layer,
  outW: number,
  options: { showRivers?: boolean; bakeCities?: boolean; vignette?: boolean } = {},
): ImageData {
  const { width: w, height: h } = world.meta
  const cw = Math.max(1, outW)
  const ch = Math.max(1, Math.round((outW * h) / Math.max(1, w)))
  const showRivers = options.showRivers ?? layer === 'relief'
  const image = new ImageData(cw, ch)
  const data = image.data
  const scale = cw / w
  const smooth = layer !== 'plates'
  for (let py = 0; py < ch; py++) {
    const yf = (py + 0.5) / scale
    for (let px = 0; px < cw; px++) {
      const xf = (px + 0.5) / scale
      const rgb = smooth
        ? sampleBilinear(world, season, layer, xf, yf, showRivers)
        : cellColor(
            world,
            season,
            layer,
            Math.min(w - 1, xf | 0),
            Math.min(h - 1, yf | 0),
            showRivers,
          )
      const o = (py * cw + px) * 4
      data[o] = rgb[0]
      data[o + 1] = rgb[1]
      data[o + 2] = rgb[2]
      data[o + 3] = 255
    }
  }
  if (options.bakeCities ?? true) stampCities(image, world, scale)
  if (options.vignette ?? true) applyVignette(image)
  return image
}

/**
 * 0 at the poles, 1 by ~12° of latitude.
 * Softens SphereGeometry UV pinch in globe bakes without flattening World elev.
 */
export function polePinchFade(ny: number): number {
  const lat = ny < 0 ? 0 : ny > 1 ? 1 : ny
  const fromPole = Math.min(lat, 1 - lat)
  const t = fromPole >= 0.07 ? 1 : fromPole / 0.07
  return t * t * (3 - 2 * t)
}

const POLE_DISP_REST = 72

/** Grey bump: ocean dark, highlands bright. Elev is metres. Bilinear so the globe is not voxels. */
export function bakeBumpImageData(world: World, scale = 2): ImageData {
  const { width: w, height: h } = world.meta
  const cw = Math.max(1, w * scale)
  const ch = Math.max(1, h * scale)
  const image = new ImageData(cw, ch)
  const data = image.data
  const threshold = world.meta.threshold
  for (let py = 0; py < ch; py++) {
    const yf = (py + 0.5) / scale
    const fade = polePinchFade((py + 0.5) / ch)
    for (let px = 0; px < cw; px++) {
      const xf = (px + 0.5) / scale
      const e = sampleElev(world, xf, yf)
      const ocean = sampleMask(world, xf, yf) < threshold
      let v = ocean
        ? Math.round(Math.max(0, 18 + (e < 0 ? (1 + e / 4000) * 50 : 40)))
        : Math.round(90 + clamp(e / 8000, 0, 1) * 165)
      v = Math.round(POLE_DISP_REST + (v - POLE_DISP_REST) * (0.4 + 0.6 * fade))
      const o = (py * cw + px) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return image
}

/** RGB normal map from elevation slope. */
export function bakeNormalImageData(world: World, scale = 2): ImageData {
  const { width: w, height: h } = world.meta
  const cw = Math.max(1, w * scale)
  const ch = Math.max(1, h * scale)
  const image = new ImageData(cw, ch)
  const data = image.data
  const threshold = world.meta.threshold
  for (let py = 0; py < ch; py++) {
    const yf = (py + 0.5) / scale
    const fade = polePinchFade((py + 0.5) / ch)
    for (let px = 0; px < cw; px++) {
      const xf = (px + 0.5) / scale
      const e = sampleElev(world, xf, yf)
      const dx = (sampleElev(world, xf + 1, yf) - sampleElev(world, xf - 1, yf)) / 400
      const dy = (sampleElev(world, xf, yf + 1) - sampleElev(world, xf, yf - 1)) / 400
      const ocean = sampleMask(world, xf, yf) < threshold
      const dz = ocean ? 0.45 : 0.85 + clamp(e / 8000, 0, 1) * 0.4
      const len = Math.hypot(dx, dy, dz) || 1
      const nr = Math.round((-dx / len) * 0.5 * 255 + 128)
      const ng = Math.round((dy / len) * 0.5 * 255 + 128)
      const nb = Math.round((dz / len) * 0.5 * 255 + 128)
      const o = (py * cw + px) * 4
      data[o] = Math.round(128 + (nr - 128) * fade)
      data[o + 1] = Math.round(128 + (ng - 128) * fade)
      data[o + 2] = Math.round(255 + (nb - 255) * fade)
      data[o + 3] = 255
    }
  }
  return image
}

/** Displacement height for the globe mesh. */
export function bakeDisplacementImageData(world: World, scale = 2): ImageData {
  const { width: w, height: h } = world.meta
  const cw = Math.max(1, w * scale)
  const ch = Math.max(1, h * scale)
  const image = new ImageData(cw, ch)
  const data = image.data
  const threshold = world.meta.threshold
  for (let py = 0; py < ch; py++) {
    const yf = (py + 0.5) / scale
    const fade = polePinchFade((py + 0.5) / ch)
    for (let px = 0; px < cw; px++) {
      const xf = (px + 0.5) / scale
      const e = sampleElev(world, xf, yf)
      const ocean = sampleMask(world, xf, yf) < threshold
      let v = ocean
        ? Math.round(40 + (e < 0 ? clamp(1 + e / 4000, 0, 1) * 30 : 20))
        : Math.round(110 + clamp(e / 8000, 0, 1) * 145)
      v = Math.round(POLE_DISP_REST + (v - POLE_DISP_REST) * fade)
      const o = (py * cw + px) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return image
}

/** Roughness: shiny ocean, matte land. */
export function bakeRoughnessImageData(world: World, scale = 2): ImageData {
  const { width: w, height: h } = world.meta
  const cw = Math.max(1, w * scale)
  const ch = Math.max(1, h * scale)
  const image = new ImageData(cw, ch)
  const data = image.data
  const threshold = world.meta.threshold
  for (let py = 0; py < ch; py++) {
    const yf = (py + 0.5) / scale
    for (let px = 0; px < cw; px++) {
      const xf = (px + 0.5) / scale
      const e = sampleElev(world, xf, yf)
      const ocean = sampleMask(world, xf, yf) < threshold
      const v = ocean
        ? Math.round(28 + (e < 0 ? clamp(1 + e / 4000, 0, 1) * 18 : 12))
        : Math.round(165 + clamp(e / 8000, 0, 1) * 55)
      const o = (py * cw + px) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return image
}

// ---------------------------------------------------------------------------
// 8. Coordinate mapping
// ---------------------------------------------------------------------------

/**
 * Map a pointer event on the atlas canvas to a grid cell.
 * Returns `null` for cursors outside the canvas.
 */
export function screenToCell(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  world: World,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect()
  const { width: w, height: h } = world.meta
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = Math.floor(((clientX - rect.left) / rect.width) * w)
  const y = Math.floor(((clientY - rect.top) / rect.height) * h)
  if (x < 0 || y < 0 || x >= w || y >= h) return null
  return { x, y }
}

/** Sub-rectangle of a DOM element returned by `getBoundingClientRect`. */
export interface ClientRect {
  left: number
  top: number
  width: number
  height: number
}

/** Normalised bitmap coordinates returned by `clientToContainedBitmap`. */
export interface NormalisedPoint {
  /** 0..1 horizontal position inside the bitmap. */
  nx: number
  /** 0..1 vertical position inside the bitmap. */
  ny: number
}

/**
 * Map a client (viewport) coordinate to a normalised point inside a
 * bitmap that has been "letterboxed" into a screen rectangle.
 *
 * The bitmap is scaled to fit the rect while preserving its aspect
 * ratio; the unused space forms letterbox bars on the long axis.
 * Returns `null` when the click lands inside a letterbox bar (i.e. on
 * the rect but off the bitmap).
 *
 * Example: a 400×200 bitmap (aspect 2:1) inside a 200×200 rect
 * (aspect 1:1) renders at 200×100 centred vertically — clicking in the
 * top 50 px of the rect returns `null`.
 */
export function clientToContainedBitmap(
  clientX: number,
  clientY: number,
  rect: ClientRect,
  bitmapWidth: number,
  bitmapHeight: number,
): NormalisedPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  if (bitmapWidth <= 0 || bitmapHeight <= 0) return null

  // Position relative to the rect (viewport → rect-local).
  const lx = clientX - rect.left
  const ly = clientY - rect.top
  if (lx < 0 || ly < 0 || lx >= rect.width || ly >= rect.height) return null

  const rectAspect = rect.width / rect.height
  const bitmapAspect = bitmapWidth / bitmapHeight

  // Fit the bitmap into the rect while preserving aspect ratio.
  let bitmapX: number, bitmapY: number, bitmapW: number, bitmapH: number
  if (rectAspect > bitmapAspect) {
    // Rect is wider than the bitmap → fit the bitmap to the rect's
    // height; vertical (left/right) letterbox bars appear.
    bitmapH = rect.height
    bitmapW = rect.height * bitmapAspect
    bitmapY = 0
    bitmapX = (rect.width - bitmapW) / 2
  } else {
    // Rect is squarer (or equal) than the bitmap → fit the bitmap to
    // the rect's width; horizontal (top/bottom) letterbox bars appear.
    bitmapW = rect.width
    bitmapH = rect.width / bitmapAspect
    bitmapX = 0
    bitmapY = (rect.height - bitmapH) / 2
  }

  // Reject clicks that fall inside a letterbox bar.
  if (lx < bitmapX || lx >= bitmapX + bitmapW) return null
  if (ly < bitmapY || ly >= bitmapY + bitmapH) return null

  return {
    nx: (lx - bitmapX) / bitmapW,
    ny: (ly - bitmapY) / bitmapH,
  }
}