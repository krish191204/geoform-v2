/**
 * Frozen Köppen-Geiger land-area targets for scoring a world's biome mix.
 *
 * Peel, Finlayson & McMahon 2007, Hydrology and Earth System Sciences
 * 11:1633–1644, "Updated world map of the Köppen-Geiger climate
 * classification." Major-group shares of Earth's land area:
 *   arid B 30.2%, cold D 24.6%, tropical A 19.0%, temperate C 13.4%,
 *   polar E 12.8%.
 *
 * Scores only. Nothing here repaints biomes or fetches a raster.
 * Beck et al. 2018 GeoTIFFs are not used.
 */

import type { BiomeId, CellBiome, World } from '../world/types'

/** Peel's five first-order Köppen groups. */
export type KoppenGroup = 'A' | 'B' | 'C' | 'D' | 'E'

export const KOPPEN_GROUPS: readonly KoppenGroup[] = ['A', 'B', 'C', 'D', 'E']

/**
 * Land-area fraction of each major group. Sums to 1.
 * Peel, Finlayson & McMahon 2007.
 */
export const EARTH_KOPPEN_LAND_FRACTION: Readonly<Record<KoppenGroup, number>> = {
  A: 0.19,
  B: 0.302,
  C: 0.134,
  D: 0.246,
  E: 0.128,
}

/**
 * Geoform biome id → Peel group.
 *
 * Hydrologic overlays have no Köppen letter of their own. Mangrove is a
 * warm-coast overlay, so it counts as tropical A. Wetland counts as cold D,
 * the group that holds most of Earth's peatland area. Alpine has no H in
 * Peel; it counts as polar E, the elevational ET/EF analog. Cold deserts
 * stay arid B (BWk), not D.
 */
export const BIOME_KOPPEN: Readonly<Record<BiomeId, KoppenGroup>> = {
  rainforest: 'A',
  savanna: 'A',
  mangrove: 'A',
  'hot-desert': 'B',
  steppe: 'B',
  'boreal-desert': 'B',
  mediterranean: 'C',
  'temperate-forest': 'C',
  'temperate-deciduous': 'C',
  taiga: 'D',
  wetland: 'D',
  ice: 'E',
  'polar-desert': 'E',
  tundra: 'E',
  alpine: 'E',
}

export type AreaFractions = Record<KoppenGroup, number>

export interface BiomeMixScore {
  /** |planet fraction − Earth fraction| for each Peel group. */
  absError: AreaFractions
  /** One line. A one-continent doodle may miss Earth. */
  note: string
}

function latDeg(y: number, height: number): number {
  if (height <= 1) return 0
  return 90 - (180 * (y + 0.5)) / height
}

function cellWeight(y: number, height: number): number {
  return Math.max(0, Math.cos((latDeg(y, height) * Math.PI) / 180))
}

function emptyFractions(): AreaFractions {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 }
}

/**
 * Area-weighted land fractions in the five Peel groups.
 * Ocean is excluded. Cell area follows cos(latitude) on the equirectangular grid.
 * No land → every fraction is 0.
 */
export function areaFractions(world: World): AreaFractions {
  const { width: w, height: h, threshold } = world.meta
  const acc = emptyFractions()
  let total = 0
  for (let y = 0; y < h; y++) {
    const weight = cellWeight(y, h)
    if (weight <= 0) continue
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (world.mask[i] < threshold) continue
      const biome: CellBiome = world.biome[i]
      if (biome === 'ocean') continue
      acc[BIOME_KOPPEN[biome]] += weight
      total += weight
    }
  }
  if (total <= 0) return emptyFractions()
  for (const g of KOPPEN_GROUPS) acc[g] /= total
  return acc
}

/** Count 4-connected land blobs. Longitude wraps; poles do not. */
function landmassCount(world: World): number {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  const seen = new Uint8Array(n)
  let count = 0
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue
    if (world.mask[i] < threshold || world.biome[i] === 'ocean') {
      seen[i] = 1
      continue
    }
    count++
    stack.push(i)
    seen[i] = 1
    while (stack.length) {
      const cur = stack.pop() as number
      const x = cur % w
      const y = (cur - x) / w
      const neighbours = [y > 0 ? cur - w : -1, y + 1 < h ? cur + w : -1, y * w + ((x + w - 1) % w), y * w + ((x + 1) % w)]
      for (const j of neighbours) {
        if (j < 0 || seen[j]) continue
        seen[j] = 1
        if (world.mask[j] >= threshold && world.biome[j] !== 'ocean') stack.push(j)
      }
    }
  }
  return count
}

function meanAbsError(err: AreaFractions): number {
  let s = 0
  for (const g of KOPPEN_GROUPS) s += err[g]
  return s / KOPPEN_GROUPS.length
}

/**
 * Absolute error of the world's land-area mix against Peel et al. 2007.
 * Does not modify the world.
 */
export function scoreBiomeMix(world: World): BiomeMixScore {
  const fractions = areaFractions(world)
  const absError = emptyFractions()
  let land = 0
  for (const g of KOPPEN_GROUPS) {
    absError[g] = Math.abs(fractions[g] - EARTH_KOPPEN_LAND_FRACTION[g])
    land += fractions[g]
  }
  if (land <= 0) {
    return {
      absError,
      note: 'No land area to compare with Peel, Finlayson & McMahon 2007.',
    }
  }
  const close = meanAbsError(absError) < 0.05
  const oneContinent = landmassCount(world) === 1
  const note = oneContinent
    ? close
      ? 'One-continent doodle, and the Köppen mix still sits near Peel, Finlayson & McMahon 2007.'
      : 'One-continent doodle: missing Earth is allowed.'
    : close
      ? 'Land-area mix is close to Peel, Finlayson & McMahon 2007.'
      : 'Land-area mix misses the Peel, Finlayson & McMahon 2007 Köppen fractions.'
  return { absError, note }
}
