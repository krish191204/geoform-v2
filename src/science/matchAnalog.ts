/**
 * Nearest Earth analog in climate-feature space.
 *
 * Distance is scaled Euclidean (Mahalanobis-lite with a diagonal
 * scale). Returns an id only — analog copy lives in `sketch/analogs`.
 * Oasis and ice still win by hydrology, not the centroid.
 */

import type { PlaceAnalogId, World } from '../world/types'
import { idx } from '../world/types'
import { EARTH_ANALOG_CENTROIDS, scaledDistance, type ClimateFeatures } from './earth'

export interface AnalogMatch {
  id: PlaceAnalogId
  /** 0..1, exp(−distance) to the Earth centroid. */
  score: number
  runnerUp: PlaceAnalogId | null
  residual: number
}

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function isLand(world: World, i: number): boolean {
  return world.mask[i] >= world.meta.threshold
}

function inland01(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  let best = 24
  for (let dy = -12; dy <= 12; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -12; dx <= 12; dx++) {
      const nx = wrapX(x + dx, w)
      if (isLand(world, idx(w, nx, ny))) continue
      const d = Math.hypot(Math.min(Math.abs(dx), w - Math.abs(dx)), dy)
      if (d < best) best = d
    }
  }
  return Math.max(0, Math.min(1, (best - 1) / 14))
}

export function featuresAt(world: World, x: number, y: number): ClimateFeatures | null {
  const { width: w, height: h } = world.meta
  if (x < 0 || y < 0 || x >= w || y >= h) return null
  const i = idx(w, x, y)
  if (!isLand(world, i)) return null
  return {
    meanT: world.tempMean[i],
    tempRange: world.tempRange[i],
    moist: world.moistMean[i],
    inland: inland01(world, x, y),
    elevKm: Math.max(0, world.elev[i] / 1000),
  }
}

export function matchFeatures(feat: ClimateFeatures): AnalogMatch {
  let bestId: PlaceAnalogId = 'temperate-farmland'
  let bestD = Infinity
  let secondId: PlaceAnalogId | null = null
  let secondD = Infinity
  for (const id of Object.keys(EARTH_ANALOG_CENTROIDS) as PlaceAnalogId[]) {
    const d = scaledDistance(feat, EARTH_ANALOG_CENTROIDS[id])
    if (d < bestD) {
      secondId = bestId
      secondD = bestD
      bestId = id
      bestD = d
    } else if (d < secondD) {
      secondId = id
      secondD = d
    }
  }
  return {
    id: bestId,
    score: Math.exp(-bestD),
    runnerUp: secondId && secondId !== bestId ? secondId : null,
    residual: bestD,
  }
}

function override(
  id: PlaceAnalogId,
  runnerUp: PlaceAnalogId | null,
  residual: number,
): AnalogMatch {
  return { id, score: 0.9, runnerUp, residual }
}

/**
 * Match a land cell to an Earth landscape analog.
 * Hydrologic specials (oasis, monsoon river, ice) override the centroid.
 */
export function matchAnalogAt(world: World, x: number, y: number): AnalogMatch | null {
  const feat = featuresAt(world, x, y)
  if (!feat) return null
  const { width: w } = world.meta
  const i = idx(w, x, y)
  const b = world.biome[i]
  const river = world.flux[i] > 8 || world.rivers[i] > 0
  if (b === 'ice' || b === 'tundra' || b === 'polar-desert') {
    return override('tundra-edge', 'boreal-forest', 0.1)
  }
  if ((b === 'hot-desert' || b === 'boreal-desert') && (feat.moist > 0.22 || river)) {
    return override('oasis-corridor', 'fog-desert-coast', 0.1)
  }
  if ((b === 'rainforest' || b === 'wetland' || b === 'mangrove') && (river || feat.inland < 0.2) && feat.meanT > 18) {
    return override('monsoon-delta', 'tropical-forest', 0.1)
  }
  const match = matchFeatures(feat)
  if (b === 'alpine' && feat.elevKm > 2.2) {
    return { ...match, id: 'highland-plateau' }
  }
  return match
}
