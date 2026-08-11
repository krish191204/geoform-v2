import type { Biome, City, ContractWorld, World, WorldEnginePayload } from './types'
import { recomputeSuitability } from './climate'

/**
 * Sorted alphabetically (mirrors `worldengine.biome.biome_index_to_name` in
 * the vendored WorldEngine). The server stores biome cells as integer indices
 * into this list; the SPA wants human-readable names.
 */
const BIOME_NAMES: string[] = [
  'boreal desert',
  'boreal dry scrub',
  'boreal moist forest',
  'boreal rain forest',
  'boreal wet forest',
  'cool temperate desert',
  'cool temperate desert scrub',
  'cool temperate moist forest',
  'cool temperate rain forest',
  'cool temperate steppe',
  'cool temperate wet forest',
  'ice',
  'ocean',
  'polar desert',
  'sea',
  'subpolar dry tundra',
  'subpolar moist tundra',
  'subpolar rain tundra',
  'subpolar wet tundra',
  'subtropical desert',
  'subtropical desert scrub',
  'subtropical dry forest',
  'subtropical moist forest',
  'subtropical rain forest',
  'subtropical thorn woodland',
  'subtropical wet forest',
  'tropical desert',
  'tropical desert scrub',
  'tropical dry forest',
  'tropical moist forest',
  'tropical rain forest',
  'tropical thorn woodland',
  'tropical very dry forest',
  'tropical wet forest',
  'warm temperate desert',
  'warm temperate desert scrub',
  'warm temperate dry forest',
  'warm temperate moist forest',
  'warm temperate rain forest',
  'warm temperate thorn scrub',
  'warm temperate wet forest',
]

function biomeIndexToName(idx: number): Biome {
  const safe = idx | 0
  return BIOME_NAMES[safe] ?? 'ocean'
}

function biomeNameToIndex(name: Biome): number {
  const idx = BIOME_NAMES.indexOf(name)
  return idx >= 0 ? idx : 0
}

/** Flatten a row-major 2D matrix to a 1D plain array. */
function flatten2D(rows: number[][] | undefined): number[] {
  if (!rows || rows.length === 0) return []
  const out: number[] = new Array(rows.length * rows[0]!.length)
  let k = 0
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!
    for (let x = 0; x < row.length; x++) {
      out[k++] = Number(row[x] ?? 0)
    }
  }
  return out
}

/**
 * Legacy stdlib-bridge wire format → typed-array `World`.
 * Kept for the existing test that constructs a `WorldEnginePayload` directly.
 */
export function worldFromPayload(
  payload: WorldEnginePayload,
  keepCities: World['cities'] = [],
): World {
  const n = payload.width * payload.height
  const world: World = {
    width: payload.width,
    height: payload.height,
    seed: payload.seed,
    seaLevel: payload.seaLevel,
    plateId: Int16Array.from(payload.plateId),
    elev: Float32Array.from(payload.elev),
    temp: Float32Array.from(payload.temp),
    moist: Float32Array.from(payload.moist),
    flux: Float32Array.from(payload.flux),
    biome: payload.biome.slice() as Biome[],
    suitability: new Float32Array(n),
    cities: keepCities.filter(
      (c) => c.x >= 0 && c.y >= 0 && c.x < payload.width && c.y < payload.height,
    ),
    plateCount: payload.plateCount,
    rawElevMin: payload.rawElevMin,
    rawElevMax: payload.rawElevMax,
    rawSeaThreshold: payload.rawSeaThreshold,
    engine: 'worldengine',
  }
  recomputeSuitability(world)
  return world
}

function filterCities(cities: City[], width: number, height: number): City[] {
  return cities.filter((c) => c.x >= 0 && c.y >= 0 && c.x < width && c.y < height)
}

/**
 * Contract `World` JSON document (server/api) → typed-array `World`.
 * Flattens 2D layers, resolves biome indices → names, and fills the
 * suitability buffer. `keepCities` is preserved across recompute.
 */
export function worldFromContractWorld(
  doc: ContractWorld,
  keepCities: World['cities'] = [],
): World {
  const { width, height, seed } = doc
  const n = width * height
  const layers = doc.layers ?? {}

  const elev = Float32Array.from(flatten2D(layers.elevation?.data))
  const plateId = Int16Array.from(flatten2D(layers.plates?.data))
  const temp = Float32Array.from(flatten2D(layers.temperature?.data))
  const moist = Float32Array.from(
    flatten2D(layers.humidity?.data ?? layers.precipitation?.data),
  )
  const flux = Float32Array.from(flatten2D(layers.watermap?.data))

  const biomeRaw = flatten2D(layers.biome?.data)
  const biome: Biome[] = new Array(n)
  for (let i = 0; i < n; i++) biome[i] = biomeIndexToName(biomeRaw[i] ?? 0)

  // Sea level: prefer the elevation layer's first threshold (the computed
  // ocean boundary), fall back to the requested `ocean_level`, then 0.42.
  let seaLevel = doc.generation_params?.ocean_level ?? 0.42
  const elevThresholds = layers.elevation?.thresholds
  if (Array.isArray(elevThresholds) && elevThresholds.length > 0) {
    const first = elevThresholds[0]
    if (Array.isArray(first) && first.length > 1 && first[1] != null) {
      seaLevel = Number(first[1])
    }
  } else if (elevThresholds && !Array.isArray(elevThresholds)) {
    const oceanish = elevThresholds['ocean'] ?? elevThresholds['sea']
    if (typeof oceanish === 'number') seaLevel = oceanish
  }

  const plateCount = doc.generation_params?.n_plates ?? 0

  let rawElevMin = Infinity
  let rawElevMax = -Infinity
  for (let i = 0; i < elev.length; i++) {
    const v = elev[i]!
    if (v < rawElevMin) rawElevMin = v
    if (v > rawElevMax) rawElevMax = v
  }
  if (!isFinite(rawElevMin)) rawElevMin = 0
  if (!isFinite(rawElevMax)) rawElevMax = seaLevel + 1

  const world: World = {
    width,
    height,
    seed,
    seaLevel,
    plateId,
    elev,
    temp,
    moist,
    flux,
    biome,
    suitability: new Float32Array(n),
    cities: filterCities(keepCities, width, height),
    plateCount,
    rawElevMin,
    rawElevMax,
    rawSeaThreshold: seaLevel,
    engine: 'worldengine',
  }
  recomputeSuitability(world)
  return world
}

function reshape1D(arr: ArrayLike<number>, width: number, height: number): number[][] {
  const rows: number[][] = new Array(height)
  for (let y = 0; y < height; y++) {
    const row: number[] = new Array(width)
    for (let x = 0; x < width; x++) {
      row[x] = Number(arr[y * width + x] ?? 0)
    }
    rows[y] = row
  }
  return rows
}

function reshapeBiomes(biomes: Biome[], width: number, height: number): number[][] {
  const rows: number[][] = new Array(height)
  for (let y = 0; y < height; y++) {
    const row: number[] = new Array(width)
    for (let x = 0; x < width; x++) {
      row[x] = biomeNameToIndex(biomes[y * width + x] ?? 'ocean')
    }
    rows[y] = row
  }
  return rows
}

/**
 * Typed-array `World` → contract `World` JSON document, suitable for
 * POSTing to `/api/recompute`. The server ignores fields it doesn't need.
 */
export function worldToContractWorld(world: World): ContractWorld {
  const { width, height, seed, seaLevel, plateCount } = world
  return {
    schema_version: 1,
    name: `world-${seed}`,
    width,
    height,
    seed,
    generation_params: {
      n_plates: plateCount,
      ocean_level: seaLevel,
      step: 'full',
      fade_borders: true,
    },
    temps: [0.874, 0.765, 0.594, 0.439, 0.366, 0.124],
    humids: [0.941, 0.778, 0.507, 0.236, 0.073, 0.014, 0.002],
    gamma_curve: 1.25,
    curve_offset: 0.2,
    layers: {
      elevation: { data: reshape1D(world.elev, width, height) },
      plates: { data: reshape1D(world.plateId, width, height) },
      temperature: { data: reshape1D(world.temp, width, height) },
      humidity: { data: reshape1D(world.moist, width, height) },
      watermap: { data: reshape1D(world.flux, width, height) },
      biome: { data: reshapeBiomes(world.biome, width, height) },
    },
    sculpt: [],
    settlements: null,
  }
}

/**
 * Options accepted by `fetchWorldEngineWorld` and `recomputeWorldEngine`.
 * The 4th positional argument to `fetchWorldEngineWorld` may also be a plain
 * number for backward compatibility with the legacy call sites in
 * `src/main.ts`.
 */
export interface WorldEngineRequestOpts {
  numPlates?: number
  signal?: AbortSignal
}

function normalizeFetchOpts(opts: number | WorldEngineRequestOpts | undefined): {
  numPlates: number
  signal: AbortSignal | undefined
} {
  if (typeof opts === 'number') {
    return { numPlates: opts, signal: undefined }
  }
  return {
    numPlates: opts?.numPlates ?? 10,
    signal: opts?.signal,
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}) as Record<string, unknown>)
  const message = (body as { message?: unknown }).message
  const error = (body as { error?: unknown }).error
  return (
    (typeof message === 'string' && message) ||
    (typeof error === 'string' && error) ||
    `HTTP ${res.status}`
  )
}

/**
 * POST `/api/generate` with the contract's required shape, then convert the
 * returned `World` JSON into the typed-array `World` the SPA consumes.
 */
export async function fetchWorldEngineWorld(
  seed: number,
  width: number,
  height: number,
  opts?: number | WorldEngineRequestOpts,
): Promise<World> {
  const { numPlates, signal } = normalizeFetchOpts(opts)
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `world-${seed}-${Date.now()}`,
      width,
      height,
      seed,
      num_plates: numPlates,
      ocean_level: 1.0,
      step: 'full',
      fade_borders: true,
    }),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res))
  }
  const doc = (await res.json()) as ContractWorld
  return worldFromContractWorld(doc)
}

/**
 * POST `/api/recompute` with the full `World` document. The server replaces
 * derived layers (climate, hydrology, biomes) and returns the refreshed
 * world. Existing `cities` are preserved.
 */
export async function recomputeWorldEngine(
  world: World,
  opts?: WorldEngineRequestOpts,
): Promise<World> {
  const doc = worldToContractWorld(world)
  const res = await fetch('/api/recompute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ world: doc }),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res))
  }
  const next = (await res.json()) as ContractWorld
  return worldFromContractWorld(next, world.cities)
}
