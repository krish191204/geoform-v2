/**
 * Foundation types for the mask-first pipeline.
 *
 * Pipeline: Sketch (mask) -> Critique (issues) -> Make-sense (world) -> Worldbuild (cities).
 * Everything downstream of `Make-sense` reads `World`; everything before it reads `WorldMeta`.
 */

// ---------------------------------------------------------------------------
// 1. Brush palette — the visible six
// ---------------------------------------------------------------------------

/** What the mouse does when you click the map. Six tools, no more. */
export type Tool =
  /** Sketch: stamp soft mask value at brush center. */
  | 'draw-land'
  /** Sketch: subtract mask value at brush center. */
  | 'erase-land'
  /** Worldbuild: place a city. */
  | 'place-city'
  /** Worldbuild: remove nearest city. */
  | 'remove-city'
  /** All stages: read the inspector. */
  | 'inspect'
  /** Default cursor. */
  | 'none'

// ---------------------------------------------------------------------------
// 2. Stage gating
// ---------------------------------------------------------------------------

/** Which step of the pipeline the editor is in; gates the tool palette. */
export type Stage = 'sketch' | 'critique' | 'make-sense' | 'worldbuild'

// ---------------------------------------------------------------------------
// 3. WorldMeta
// ---------------------------------------------------------------------------

/** Sketch-stage parameters; locked at Make-sense entry and copied into `World`. */
export interface WorldMeta {
  seed: number
  width: number
  height: number
  /** Default 6371. User range 2000–50000. */
  planetRadiusKm: number
  /** Default 23.5. User range 0–45. Drives seasonal swing. */
  obliquityDeg: number
  /** 0..1 fractional, default 0.5. */
  seaLevel: number
  /** Mask threshold for freeze intent, default 0.5. */
  threshold: number
}

/** Defaults for a fresh sketch — Geoform 1 HD grid. Spread and override. */
export const DEFAULT_META: Readonly<WorldMeta> = {
  seed: 1,
  width: 768,
  height: 384,
  planetRadiusKm: 6371,
  obliquityDeg: 23.5,
  seaLevel: 0.5,
  threshold: 0.5,
}

// ---------------------------------------------------------------------------
// 5. Seasons
// ---------------------------------------------------------------------------

/** How many seasonal samples the climate model ran. v1 = 2, v2 = 4. */
export type Seasons = 2 | 4

/** The season count v1 ships. */
export const SEASONS_V1: Seasons = 2

// ---------------------------------------------------------------------------
// 6. City
// ---------------------------------------------------------------------------

/** A settlement placed during Worldbuild. */
export type SettlementRole =
  | 'seat_of_power'
  | 'farmland'
  | 'fishing'
  | 'mining'
  | 'hunting'
  | 'trade'
  | 'pastoral'

export interface City {
  x: number
  y: number
  name: string
  /** 0..1 suitability score accounting for seasonality. */
  seasonal: number
  /** What this town does — set when auto-placed or inferred on found. */
  role?: SettlementRole
}

// ---------------------------------------------------------------------------
// 11. Biome palette
// ---------------------------------------------------------------------------

/** The twelve land biomes a writer can actually see on the atlas. */
export type BiomeId =
  | 'ice'
  | 'polar-desert'
  | 'tundra'
  | 'taiga'
  | 'boreal-desert'
  | 'steppe'
  | 'temperate-forest'
  | 'rainforest'
  | 'savanna'
  | 'hot-desert'
  | 'mediterranean'
  | 'alpine'

/** Per-cell biome value: a land biome, or `ocean` for cells below sea level. */
export type CellBiome = BiomeId | 'ocean'

/** Inclusive `[min, max]` envelope for one climate axis. */
export type Range = readonly [min: number, max: number]

/** One row of the atlas palette: the climate box a biome occupies, plus its color. */
export interface BiomeSpec {
  id: BiomeId
  label: string
  /** Annual mean temperature envelope, °C. */
  meanTempC: Range
  /** Annual temperature swing envelope, °C. */
  tempRangeC: Range
  /** Monthly precipitation index envelope, 0..1. */
  moistIdx: Range
  /** Hex color, `#rrggbb`. */
  color: string
}

/**
 * The atlas palette. Twelve honest entries keyed off
 * (`tempMean`, `tempRange`, `summerMoist`) — no duplicates, no aliases.
 */
export const BIOME_COLORS: readonly BiomeSpec[] = [
  {
    id: 'ice',
    label: 'Ice',
    meanTempC: [-60, -10],
    tempRangeC: [0, 60],
    moistIdx: [0, 1],
    color: '#e8f0f4',
  },
  {
    id: 'polar-desert',
    label: 'Polar desert',
    meanTempC: [-10, -2],
    tempRangeC: [0, 60],
    moistIdx: [0, 0.15],
    color: '#dce3e6',
  },
  {
    id: 'tundra',
    label: 'Tundra',
    meanTempC: [-10, 2],
    tempRangeC: [0, 60],
    moistIdx: [0.15, 1],
    color: '#b7c4b0',
  },
  {
    id: 'boreal-desert',
    label: 'Boreal desert',
    meanTempC: [-2, 6],
    tempRangeC: [0, 60],
    moistIdx: [0, 0.2],
    color: '#c4b89a',
  },
  {
    id: 'taiga',
    label: 'Taiga',
    meanTempC: [-2, 6],
    tempRangeC: [0, 60],
    moistIdx: [0.2, 1],
    color: '#4f6b52',
  },
  {
    id: 'steppe',
    label: 'Steppe',
    meanTempC: [6, 18],
    tempRangeC: [18, 60],
    moistIdx: [0.15, 0.4],
    color: '#8fad5f',
  },
  {
    id: 'mediterranean',
    label: 'Mediterranean',
    meanTempC: [10, 20],
    tempRangeC: [0, 18],
    moistIdx: [0.2, 0.45],
    color: '#a8b45c',
  },
  {
    id: 'temperate-forest',
    label: 'Temperate forest',
    meanTempC: [6, 18],
    tempRangeC: [0, 60],
    moistIdx: [0.4, 1],
    color: '#3d6b45',
  },
  {
    id: 'hot-desert',
    label: 'Hot desert',
    meanTempC: [18, 40],
    tempRangeC: [0, 60],
    moistIdx: [0, 0.15],
    color: '#d4b483',
  },
  {
    id: 'savanna',
    label: 'Savanna',
    meanTempC: [18, 40],
    tempRangeC: [0, 60],
    moistIdx: [0.15, 0.5],
    color: '#c4a35a',
  },
  {
    id: 'rainforest',
    label: 'Rainforest',
    meanTempC: [18, 40],
    tempRangeC: [0, 60],
    moistIdx: [0.5, 1],
    color: '#1f4d38',
  },
  {
    id: 'alpine',
    label: 'Alpine',
    meanTempC: [-60, 40],
    tempRangeC: [0, 60],
    moistIdx: [0, 1],
    color: '#8a8f8c',
  },
]

/** Ocean is not a biome — it falls out of the mask — but it still needs a color. */
export const OCEAN_COLOR = '#1f5f74'

/** Fast id -> spec lookup over `BIOME_COLORS`. */
export const BIOME_BY_ID: Readonly<Record<BiomeId, BiomeSpec>> = Object.fromEntries(
  BIOME_COLORS.map((b) => [b.id, b]),
) as Record<BiomeId, BiomeSpec>

/** Atlas color for a per-cell biome value. Total — every `CellBiome` resolves. */
export function biomeColor(id: CellBiome): string {
  return id === 'ocean' ? OCEAN_COLOR : BIOME_BY_ID[id].color
}

// ---------------------------------------------------------------------------
// 4. World
// ---------------------------------------------------------------------------

/** The committed world: everything Make-sense derived from the Sketch mask. */
export interface World {
  meta: WorldMeta

  /** Authoritative soft land mask from Sketch, 0..1, length W*H. */
  mask: Float32Array

  /** Plate assignment per cell, derived from the mask. */
  plateId: Int16Array
  /** Plate drift, cells per million years. */
  plateVx: Float32Array
  plateVy: Float32Array

  /** Elevation in METRES (not unitless 0..1). */
  elev: Float32Array

  /** How many seasonal samples the arrays below represent. v1 = 2. */
  seasons: Seasons
  /** Mean temperature (°C) over the warm half of the year. */
  summer: Float32Array
  /** Mean temperature (°C) over the cold half of the year. */
  winter: Float32Array
  /** Monthly precipitation index (0..1) over the warm half. */
  summerMoist: Float32Array
  /** Monthly precipitation index (0..1) over the cold half. */
  winterMoist: Float32Array

  /** Annual mean temperature, °C. Cached aggregate for the atlas default. */
  tempMean: Float32Array
  /** Annual temperature swing, °C (summer − winter). */
  tempRange: Float32Array
  /** Annual mean precipitation index, 0..1. */
  moistMean: Float32Array

  /** Accumulated downhill water flux per cell. */
  flux: Float32Array
  /** 1 = river cell, 0 = not. */
  rivers: Uint8Array

  /** Per-cell biome name, keyed off (tempMean, tempRange, summerMoist). Length W*H. */
  biome: CellBiome[]

  /** Per-cell city-placement suitability score, 0..1. Length W*H. */
  suitability: Float32Array

  cities: City[]
}

// ---------------------------------------------------------------------------
// 7. Issues
// ---------------------------------------------------------------------------

/** One thing Critique found wrong, with the cells that prove it. */
export interface Issue {
  id: string
  severity: 'critical' | 'major' | 'minor'
  title: string
  critique: string
  fix: string
  /** Cells that triggered this issue. */
  evidence: { x: number; y: number }[]
}

// ---------------------------------------------------------------------------
// 8. Provenance
// ---------------------------------------------------------------------------

/** The anti-gaslight trail: what Make-sense did, and how much it moved. */
export interface Provenance {
  steps: { name: string; at: number; measurements: Record<string, number> }[]
  inputMaskArea: number
  outputMaskArea: number
  maskDeltaPct: number
  scoreBefore: number
  scoreAfter: number
}

// ---------------------------------------------------------------------------
// 9. EditorState
// ---------------------------------------------------------------------------

/** The whole bundle the shell holds; one object, one source of truth. */
export interface EditorState {
  stage: Stage
  /** Null until Make-sense commits. */
  world: World | null
  /** Editable during Sketch; copied into `world.meta` on commit. */
  meta: WorldMeta
  tool: Tool
  brushSize: number
  strength: number
  /** Last critique result. */
  issues: Issue[]
  /** Last make-sense result. */
  provenance: Provenance | null
  isProcessing: boolean
}

// ---------------------------------------------------------------------------
// 10. Drawing primitives
// ---------------------------------------------------------------------------

/** Row-major cell index into a W*H typed array. */
export function idx(w: number, x: number, y: number): number {
  return y * w + x
}

/** Clamp `v` into `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------
// 12. Kept exports
// ---------------------------------------------------------------------------

/** The seven viewable layers in the atlas. */
export type Layer =
  | 'relief'
  | 'plates'
  | 'elevation'
  | 'moisture'
  | 'temperature'
  | 'biome'
  | 'suitability'

export { createRng, hash2, valueNoise2D, fbm } from './noise'
