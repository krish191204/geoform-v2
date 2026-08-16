export type Layer =
  | 'relief'
  | 'plates'
  | 'elevation'
  | 'moisture'
  | 'temperature'
  | 'biome'
  | 'suitability'

/** What the mouse does when you click the map. */
export type Tool =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'ridge'
  | 'channel'
  | 'plateau'
  | 'sea'
  | 'land'
  | 'city'
  | 'razecity'
  | 'inspect'
  | 'continent'

/** WorldEngine Holdridge names + a few UI aliases */
export type Biome = string

export interface City {
  x: number
  y: number
  name: string
  score: number
  /** Optional role inferred by settlements.ts / director.ts. */
  role?: SettlementRole
}

export interface SuitabilityResult {
  score: number
  ok: boolean
  reasons: string[]
  /** Discrete tier used by placement.ts and settlements.ts gates. */
  tier?: SuitabilityTier
}

export interface World {
  width: number
  height: number
  seed: number
  seaLevel: number
  plateId: Int16Array
  elev: Float32Array
  temp: Float32Array
  moist: Float32Array
  flux: Float32Array
  biome: Biome[]
  suitability: Float32Array
  cities: City[]
  plateCount: number
  /** WorldEngine raw elevation calibration (for recompute) */
  rawElevMin: number
  rawElevMax: number
  rawSeaThreshold: number
  engine: 'worldengine' | 'local'
  /**
   * Wish, not a measurement: "I want this fraction of cells to be land."
   * 0.40 means 40% land. Repair tries to honor it by growing or shrinking
   * existing coasts — not by sprinkling islands.
   * Populated by B-side director/timeline modules as a side effect.
   */
  landRatio?: number
  /**
   * How land should clump.
   * continents = 2–3 big blobs (Earth look). Speckles get drowned.
   * mixed      = a few big ones plus leftovers.
   * islands    = keep the speckles. Only this mode wants archipelagos.
   * Populated by B-side director/expand modules.
   */
  continentMass?: 'continents' | 'mixed' | 'islands'
  /** Maritime trade lanes between coastal settlements.
   *  Populated by B-side expand/placement modules. */
  tradeRoutes?: TradeRoute[]
  /** How fast each plate slides, in cells per million years.
   *  Populated by B-side geography/plate modules. */
  plateVx?: Float32Array
  plateVy?: Float32Array
  /**
   * World-space origin of cell (0,0). When the map zooms out we add cells
   * around the edge, so the old (0,0) is no longer the corner.
   * originX/Y remember that. Populated by B-side expand/zoom-out modules.
   */
  originX?: number
  originY?: number
  /**
   * How many rows "full planet latitude" uses. Frozen at generate so zoom-out
   * padding does not suddenly restyle climate (equator would jump).
   * Populated by B-side geography module.
   */
  latRows?: number
  /** Brush-stroke log; sent to /api/recompute so the server can re-apply
   *  every stroke from scratch on a fresh elevation derived from `seed`. */
  sculpt: Array<{ x: number; y: number; radius: number; delta: number; tool: 'raise' | 'lower' }>
}

const FALLBACK_BIOME = '#6e7f6a'

/** Colors for WorldEngine biomes + simple aliases */
export const BIOME_COLORS: Record<string, string> = {
  ocean: '#1f5f74',
  coast: '#3d8a9a',
  ice: '#e8f0f4',
  'polar desert': '#dce3e6',
  'subpolar dry tundra': '#b7c4b0',
  'subpolar moist tundra': '#a8b8a4',
  'subpolar wet tundra': '#9aaf96',
  'subpolar rain tundra': '#8ba688',
  'boreal desert': '#c4b89a',
  'boreal dry scrub': '#9aaa78',
  'boreal moist forest': '#4f6b52',
  'boreal wet forest': '#3f5f44',
  'boreal rain forest': '#35583c',
  'cool temperate desert': '#d4b483',
  'cool temperate desert scrub': '#c4a86e',
  'cool temperate steppe': '#8fad5f',
  'cool temperate moist forest': '#3d6b45',
  'cool temperate wet forest': '#345c3c',
  'cool temperate rain forest': '#2c5240',
  'warm temperate desert': '#d9bc8a',
  'warm temperate desert scrub': '#c9ac72',
  'warm temperate thorn scrub': '#b89a5c',
  'warm temperate dry forest': '#5a8a4a',
  'warm temperate moist forest': '#3d6b45',
  'warm temperate wet forest': '#2f5a3a',
  'warm temperate rain forest': '#264d36',
  'subtropical desert': '#d4b483',
  'subtropical desert scrub': '#c4a35a',
  'subtropical thorn woodland': '#b8974e',
  'subtropical dry forest': '#6a9a4a',
  'subtropical moist forest': '#3d7a4a',
  'subtropical wet forest': '#2f6a42',
  'subtropical rain forest': '#1f5a3a',
  'tropical desert': '#d8b67a',
  'tropical desert scrub': '#c4a35a',
  'tropical thorn woodland': '#b8974e',
  'tropical dry forest': '#6a9a4a',
  'tropical very dry forest': '#7aa050',
  'tropical moist forest': '#2d6b48',
  'tropical wet forest': '#1f5a3e',
  'tropical rain forest': '#1f4d38',
  // legacy simple names
  tundra: '#b7c4b0',
  taiga: '#4f6b52',
  grassland: '#8fad5f',
  forest: '#3d6b45',
  rainforest: '#1f4d38',
  savanna: '#c4a35a',
  desert: '#d4b483',
  alpine: '#8a8f8c',
}

export function biomeColor(name: string): string {
  if (BIOME_COLORS[name]) return BIOME_COLORS[name]
  // fuzzy fallbacks
  if (name.includes('ocean')) return BIOME_COLORS.ocean
  if (name.includes('ice')) return BIOME_COLORS.ice
  if (name.includes('desert')) return BIOME_COLORS.desert
  if (name.includes('rain forest') || name.includes('rainforest')) return BIOME_COLORS.rainforest
  if (name.includes('forest')) return BIOME_COLORS.forest
  if (name.includes('tundra')) return BIOME_COLORS.tundra
  if (name.includes('steppe') || name.includes('grass')) return BIOME_COLORS.grassland
  if (name.includes('scrub') || name.includes('thorn') || name.includes('savanna'))
    return BIOME_COLORS.savanna
  return FALLBACK_BIOME
}

/**
 * Legacy stdlib-bridge wire format. Kept around for the test that exercises
 * `worldFromPayload` directly. The current bridge (`/api/generate`,
 * `/api/recompute` on `server/api/`) uses `ContractWorld` instead.
 */
export interface WorldEnginePayload {
  engine: string
  width: number
  height: number
  seed: number
  seaLevel: number
  plateCount: number
  elev: number[]
  plateId: number[]
  temp: number[]
  moist: number[]
  flux: number[]
  biome: string[]
  rawElevMin: number
  rawElevMax: number
  rawSeaThreshold: number
}

/**
 * A single layer in the contract `World` JSON document
 * (see `docs/contract.md`). The contents of `data` are always a 2D array
 * (rows × cols) of numbers; biome indices are integers, the rest are floats.
 */
export interface ContractLayer {
  data: number[][]
  thresholds?: Array<[string, number | null]> | Record<string, number | null>
  quantiles?: Record<string, number>
}

/**
 * Full `World` JSON document returned by `server.api`'s
 * `/api/generate` and `/api/recompute` endpoints.
 *
 * Only the fields the client bridge actually reads are typed strictly;
 * everything else stays loose to absorb future schema additions without
 * requiring a TS update.
 */
export interface ContractWorld {
  schema_version: number
  name: string
  width: number
  height: number
  seed: number
  generation_params: {
    n_plates: number
    ocean_level: number
    step: string
    fade_borders: boolean
  }
  temps: number[]
  humids: number[]
  gamma_curve: number
  curve_offset: number
  layers: {
    elevation?: ContractLayer
    plates?: ContractLayer
    ocean?: ContractLayer
    sea_depth?: ContractLayer
    precipitation?: ContractLayer
    temperature?: ContractLayer
    humidity?: ContractLayer
    permeability?: ContractLayer
    watermap?: ContractLayer
    irrigation?: ContractLayer
    lake_map?: ContractLayer
    river_map?: ContractLayer
    biome?: ContractLayer
    icecap?: ContractLayer
  }
  sculpt?: unknown[]
  settlements?: unknown
}

/**
 * B-side worldbuilding types (settlements, trade routes, suitability).
 * Appended verbatim from the snapshot at geoform-cursor-geoform-worldengine-mvp
 * so modules copied in from that snapshot (history, timeline, expand, director,
 * placement, geography) compile against the same shapes they were written for.
 *
 * Fields on `World` that these modules populate (`landRatio`, `continentMass`,
 * `tradeRoutes`, `plateVx/Vy`, `originX/Y`, `latRows`) are declared optional on
 * the A-side `World` above — A's `worldFromPayload` bridge never touches them,
 * and B's modules fill them in as a side effect.
 */

/** What a settlement primarily does economically. */
export type SettlementRole =
  | 'seat_of_power'
  | 'farmland'
  | 'fishing'
  | 'mining'
  | 'hunting'
  | 'trade'
  | 'pastoral'

/** How safe a sea cell is for shipping. */
export type SeaNavClass = 'open' | 'coastal' | 'polar' | 'blocked'

/** A maritime lane between two port settlements. */
export interface TradeRoute {
  id: string
  /** Index into world.cities */
  from: number
  to: number
  /** Ocean waypoints (grid coords), including start/end port cells. */
  waypoints: { x: number; y: number }[]
  /** Worst hazard class along the route. */
  hazard: 'open' | 'coastal' | 'polar' | 'mixed'
}

/** Settlement viability — not one ideal biome, but can vs cannot. */
export type SuitabilityTier = 'blocked' | 'marginal' | 'favorable'
