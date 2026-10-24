/**
 * Economic geology read off the grounded world: where a prospector would find
 * metal ore, building stone, salt, timber, fertile soil, fishing grounds, and gems.
 *
 * Rock codes arrive as a plain per-cell array so this stays independent of the
 * lithology pass. Pure and deterministic: reads `world` and `lith`, writes neither.
 */

import type { CellBiome, World } from '../world/types'

export const RESOURCE = { ORE: 1, STONE: 2, SALT: 4, TIMBER: 8, FERTILE: 16, FISH: 32, GEMS: 64 } as const

export const RESOURCE_LABEL: Record<number, string> = {
  [RESOURCE.ORE]: 'metal ore',
  [RESOURCE.STONE]: 'building stone',
  [RESOURCE.SALT]: 'salt',
  [RESOURCE.TIMBER]: 'timber',
  [RESOURCE.FERTILE]: 'fertile soil',
  [RESOURCE.FISH]: 'fishing grounds',
  [RESOURCE.GEMS]: 'gemstones',
}

export interface ResourceReading {
  /** Bitmask of `RESOURCE` flags per cell. Ocean cells are 0. */
  flags: Uint8Array
  /** Cells carrying each flag, keyed by flag value. */
  counts: Record<number, number>
}

/** Rock codes shared with the lithology pass. */
const LITH = {
  CRATON: 1,
  FOLD_BELT: 2,
  VOLCANIC_ARC: 3,
  SEDIMENTARY_BASIN: 5,
  ALLUVIUM: 6,
  EVAPORITE: 7,
} as const

/** Description and summary order. */
const FLAG_ORDER: readonly number[] = [
  RESOURCE.ORE,
  RESOURCE.STONE,
  RESOURCE.SALT,
  RESOURCE.TIMBER,
  RESOURCE.FERTILE,
  RESOURCE.FISH,
  RESOURCE.GEMS,
]

const FOREST_BIOMES: ReadonlySet<CellBiome> = new Set<CellBiome>([
  'taiga',
  'temperate-forest',
  'temperate-deciduous',
  'rainforest',
])

/** Share of shield cells carrying a greenstone-belt deposit. */
const CRATON_ORE_SHARE = 0.15
/** Share of shield cells carrying a kimberlite pipe. */
const CRATON_GEM_SHARE = 0.04
/** Metres. Fold-belt metamorphics this high expose gem-grade pegmatite and skarn. */
const GEM_FOLD_MIN_ELEV_M = 1500
/** Metres. Above this the forest is too stunted to log. */
const TIMBER_MAX_ELEV_M = 2500
const FERTILE_TEMP_C: readonly [number, number] = [8, 28]
const FERTILE_MOIST: readonly [number, number] = [0.25, 0.75]
const FERTILE_MAX_ELEV_M = 800
/** °C. Cooler shelf water is the nutrient-rich, productive kind. */
const FISH_MAX_TEMP_C = 22

const ORE_SALT = 0x2f6b1d3a
const GEM_SALT = 0x5bd1e995

/** Deterministic 0..1 hash of a cell index; `salt` keeps ore and gem draws independent. */
function hash01(i: number, salt: number): number {
  let h = (i ^ salt) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function inRange(v: number, [lo, hi]: readonly [number, number]): boolean {
  return v >= lo && v <= hi
}

function emptyCounts(): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const f of FLAG_ORDER) counts[f] = 0
  return counts
}

/** Per-cell resource flags from rock, relief, climate, biome, and coast. */
export function readResources(world: World, lith: Uint8Array): ResourceReading {
  const w = world.meta.width
  const h = world.meta.height
  const cells = w * h
  const n = Number.isInteger(cells) && cells > 0 ? cells : 0
  const flags = new Uint8Array(n)
  const counts = emptyCounts()
  if (
    n === 0 ||
    lith.length !== n ||
    world.mask.length !== n ||
    world.elev.length !== n ||
    world.tempMean.length !== n ||
    world.moistMean.length !== n ||
    world.rivers.length !== n ||
    world.biome.length !== n
  ) {
    return { flags, counts }
  }

  const { mask, elev, tempMean, moistMean, rivers, biome } = world
  const threshold = world.meta.threshold
  const land = new Uint8Array(n)
  for (let i = 0; i < n; i++) land[i] = mask[i] >= threshold ? 1 : 0

  const west = (row: number, x: number) => row + (x === 0 ? w - 1 : x - 1)
  const east = (row: number, x: number) => row + (x === w - 1 ? 0 : x + 1)

  const coast = new Uint8Array(n)
  const mouth = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      if (!land[i]) continue
      const touchesOcean =
        !land[west(row, x)] ||
        !land[east(row, x)] ||
        (y > 0 && !land[i - w]) ||
        (y < h - 1 && !land[i + w])
      if (!touchesOcean) continue
      coast[i] = 1
      if (rivers[i]) mouth[i] = 1
    }
  }

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const i = row + x
      if (!land[i]) continue
      const rock = lith[i]
      const z = elev[i]
      let f = 0

      if (
        rock === LITH.FOLD_BELT ||
        rock === LITH.VOLCANIC_ARC ||
        (rock === LITH.CRATON && hash01(i, ORE_SALT) < CRATON_ORE_SHARE)
      ) {
        f |= RESOURCE.ORE
      }
      if (rock === LITH.CRATON || rock === LITH.SEDIMENTARY_BASIN || rock === LITH.FOLD_BELT) {
        f |= RESOURCE.STONE
      }
      if (rock === LITH.EVAPORITE) f |= RESOURCE.SALT
      if (FOREST_BIOMES.has(biome[i]) && z < TIMBER_MAX_ELEV_M) f |= RESOURCE.TIMBER
      if (
        (rock === LITH.ALLUVIUM || rock === LITH.SEDIMENTARY_BASIN) &&
        inRange(tempMean[i], FERTILE_TEMP_C) &&
        inRange(moistMean[i], FERTILE_MOIST) &&
        z < FERTILE_MAX_ELEV_M
      ) {
        f |= RESOURCE.FERTILE
      }
      if (coast[i]) {
        const nearMouth =
          mouth[i] ||
          mouth[west(row, x)] ||
          mouth[east(row, x)] ||
          (y > 0 && mouth[i - w]) ||
          (y < h - 1 && mouth[i + w])
        if (tempMean[i] < FISH_MAX_TEMP_C || nearMouth) f |= RESOURCE.FISH
      }
      if (
        (rock === LITH.FOLD_BELT && z > GEM_FOLD_MIN_ELEV_M) ||
        (rock === LITH.CRATON && hash01(i, GEM_SALT) < CRATON_GEM_SHARE)
      ) {
        f |= RESOURCE.GEMS
      }

      flags[i] = f
      if (f) {
        for (const flag of FLAG_ORDER) if (f & flag) counts[flag]++
      }
    }
  }

  return { flags, counts }
}

/** Plain-English list of a cell's flags, e.g. `metal ore and timber`; `''` when none. */
export function describeResources(flags: number): string {
  const labels: string[] = []
  for (const f of FLAG_ORDER) if (flags & f) labels.push(RESOURCE_LABEL[f])
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** One row per resource present, most widespread first. */
export function resourceSummary(r: ResourceReading): { flag: number; label: string; cells: number }[] {
  const rows: { flag: number; label: string; cells: number }[] = []
  for (const flag of FLAG_ORDER) {
    const cells = r.counts[flag] ?? 0
    if (cells > 0) rows.push({ flag, label: RESOURCE_LABEL[flag], cells })
  }
  return rows.sort((a, b) => b.cells - a.cells || a.flag - b.flag)
}
