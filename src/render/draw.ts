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
  return v !== undefined && Number.isFinite(v) ? v.toFixed(2) : '—'
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
  const tr = tempRange[i]
  const ms = summerMoist[i]
  const mw = winterMoist[i]
  const b = typeof biome[i] === 'string' && biome[i].length > 0 ? biome[i] : undefined

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
      tempRange: fmtCelsius(tr),
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
 * Banded elevation ramp, no hillshade, no rivers.
 * Used by the Elevation layer and as the base for Relief.
 */
function elevBandColor(e: number, sea: number): [number, number, number] {
  if (!Number.isFinite(e) || !Number.isFinite(sea)) return [120, 120, 120]
  if (e < sea) {
    const t = sea > 0 ? e / sea : 0
    if (t < 0.45) return mix([8, 28, 48], [18, 62, 92], t / 0.45)
    if (t < 0.85) return mix([18, 62, 92], [36, 110, 128], (t - 0.45) / 0.4)
    return mix([36, 110, 128], [70, 150, 148], (t - 0.85) / 0.15)
  }
  const t = (e - sea) / Math.max(1e-6, 1 - sea)
  if (t < 0.08) return mix([168, 176, 122], [92, 138, 72], t / 0.08)
  if (t < 0.28) return mix([92, 138, 72], [58, 112, 58], (t - 0.08) / 0.2)
  if (t < 0.5) return mix([58, 112, 58], [110, 118, 72], (t - 0.28) / 0.22)
  if (t < 0.72) return mix([110, 118, 72], [128, 112, 88], (t - 0.5) / 0.22)
  if (t < 0.88) return mix([128, 112, 88], [168, 162, 152], (t - 0.72) / 0.16)
  return mix([168, 162, 152], [246, 248, 250], (t - 0.88) / 0.12)
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
  const t = ramp(m)
  if (t < 0.35) return mix([196, 150, 88], [170, 140, 70], t / 0.35)
  if (t < 0.65) return mix([170, 140, 70], [70, 130, 90], (t - 0.35) / 0.3)
  return mix([70, 130, 90], [30, 100, 140], (t - 0.65) / 0.35)
}

/**
 * Suitability ramp: hostile → hospitable. The new `World` does not carry
 * an explicit per-cell suitability score, so this layer visualises the
 * annual mean precipitation (`moistMean`) — the closest honest field.
 */
function suitColor(s: number): [number, number, number] {
  const t = ramp(s)
  if (t < 0.35) return mix([120, 48, 40], [170, 90, 40], t / 0.35)
  if (t < 0.55) return mix([170, 90, 40], [170, 150, 50], (t - 0.35) / 0.2)
  return mix([170, 150, 50], [50, 140, 70], (t - 0.55) / 0.45)
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

function elevAt(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const cx = Math.max(0, Math.min(w - 1, x))
  const cy = Math.max(0, Math.min(h - 1, y))
  return world.elev[cy * w + cx]
}

function isCoast(world: World, x: number, y: number): boolean {
  const { width: w, height: h, seaLevel } = world.meta
  if (x < 0 || y < 0 || x >= w || y >= h) return false
  const land = world.elev[y * w + x] >= seaLevel
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nLand = world.elev[ny * w + nx] >= seaLevel
      if (nLand !== land) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 6. Per-cell colour (pure)
// ---------------------------------------------------------------------------

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
  const { width: w, height: h, seaLevel } = world.meta
  if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0]
  const i = y * w + x
  const e = world.elev[i]
  let rgb: [number, number, number]

  switch (layer) {
    case 'relief': {
      rgb = elevBandColor(e, seaLevel)
      // Hillshade: soft directional light from the NW corner.
      const er = elevAt(world, x + 1, y)
      const ed = elevAt(world, x, y + 1)
      const dx = (e - er) * 0.0042
      const dy = (e - ed) * 0.003
      const shade = clamp(0.72 + dx + dy, 0.55, 1.25)
      rgb = [clamp(rgb[0] * shade), clamp(rgb[1] * shade), clamp(rgb[2] * shade)]
      // River overlay: lit cells that are flagged as river.
      if (showRivers && e >= seaLevel && world.rivers[i] === 1) {
        rgb = mix(rgb, [55, 140, 190], 0.6)
      }
      break
    }
    case 'elevation': {
      // Banded ramp only — no hillshade, no rivers.
      rgb = elevBandColor(e, seaLevel)
      break
    }
    case 'plates': {
      rgb = plateColor(world.plateId[i])
      if (e < seaLevel) rgb = mix(rgb, [20, 50, 70], 0.55)
      break
    }
    case 'moisture': {
      const m = season === 'summer' ? world.summerMoist[i] : world.winterMoist[i]
      rgb = moistureColor(m)
      break
    }
    case 'temperature': {
      const t = season === 'summer' ? world.summer[i] : world.winter[i]
      rgb = tempColor(t)
      break
    }
    case 'biome': {
      rgb = hexToRgb(biomeColor(world.biome[i] ?? 'ocean'))
      break
    }
    case 'suitability': {
      // Was world.moistMean (annual mean precipitation — wrong field).
      // Render world.suitability (the per-cell city placement score,
      // 0..1) which is what the Suitability layer is conceptually for.
      rgb = suitColor(world.suitability[i])
      break
    }
  }

  // Coastal ink/foam — applies to topographical layers, never to plates.
  if (layer !== 'plates' && isCoast(world, x, y)) {
    rgb = e < seaLevel ? mix(rgb, [210, 230, 230], 0.28) : mix(rgb, [30, 42, 36], 0.22)
  }

  return rgb
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
  } else {
    // Nearest-neighbour up-sample so blocky atlases stay sharp.
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