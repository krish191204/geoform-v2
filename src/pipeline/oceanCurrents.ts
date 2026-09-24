/**
 * Coastal ocean currents — an Earth-like sketch, not a GCM.
 *
 * Western boundaries of an ocean basin (water just east of a continent)
 * carry a warm poleward current. Eastern boundaries (water just west of
 * a continent) carry a cold equatorward current. The bias is a few cells
 * wide so seasonal climate can warm or cool coastal SST and change how
 * much moisture the existing wind march picks up over the sea.
 *
 * Subtropical west coasts dry out beside the cold current (fog deserts).
 * West coasts in the westerlies stay mild: a smaller annual range, as the
 * drifted warm water arrives from offshore.
 */

import { idx, latRad, wrapX } from './helpers'

export interface OceanCurrents {
  /** °C added to summer and winter before the latitude mix. */
  tempBias: Float32Array
  /** 0..1. West-coast cells in the westerlies; compresses the annual range. */
  mild: Float32Array
  /** Multiplier on ocean evaporation inside the moisture march. */
  evapScale: Float32Array
  /** Multiplier on the finished precipitation index. */
  moistScale: Float32Array
  /** Writer-facing cause, or empty when no coast carries a current. */
  note: '' | 'cold current' | 'warm current'
}

/** How far (in cells) a boundary current reaches off the coast. */
const REACH = 4
const WARM_C = 3.2
const COLD_C = 3.6

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

/** Distance to land walking +dx along the row, or 0 when none within REACH. */
function landDist(
  mask: Float32Array,
  x: number,
  y: number,
  dx: 1 | -1,
  width: number,
  threshold: number,
  reach: number,
): number {
  for (let s = 1; s <= reach; s++) {
    const nx = wrapX(x + dx * s, width)
    if (mask[idx(width, nx, y)] >= threshold) return s
  }
  return 0
}

function latDeg(y: number, height: number): number {
  return Math.abs(latRad(y, height)) * (180 / Math.PI)
}

/** Warm western-boundary currents peak in the mid-latitudes. */
function warmFactor(deg: number): number {
  const d = deg - 40
  return Math.exp(-(d * d) / 420)
}

/** Cold eastern-boundary currents peak in the subtropics (fog-desert belt). */
function coldFactor(deg: number): number {
  const d = deg - 28
  return Math.exp(-(d * d) / 200)
}

/**
 * Per-cell current bias. Deterministic from the mask and the grid.
 * Open ocean far from land is left alone.
 */
export function computeOceanCurrents(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  strength: number = 1,
): OceanCurrents {
  const n = width * height
  const tempBias = new Float32Array(n)
  const mild = new Float32Array(n)
  const evapScale = new Float32Array(n)
  const moistScale = new Float32Array(n)
  evapScale.fill(1)
  moistScale.fill(1)

  // Strength 0 is today's planet with currents switched off.
  if (!(strength > 0)) {
    return { tempBias, mild, evapScale, moistScale, note: '' }
  }

  const reach = REACH * strength
  const warmC = WARM_C * strength
  const coldC = COLD_C * strength

  const ocean = new Uint8Array(n)
  for (let i = 0; i < n; i++) ocean[i] = mask[i] < threshold ? 1 : 0

  for (let y = 0; y < height; y++) {
    const deg = latDeg(y, height)
    const warmK = warmFactor(deg)
    const coldK = coldFactor(deg)
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (!ocean[i]) continue
      const toWest = landDist(mask, x, y, -1, width, threshold, reach)
      const toEast = landDist(mask, x, y, 1, width, threshold, reach)
      // Western ocean boundary: land is to the west, and it is the nearer shore.
      const western = toWest > 0 && (toEast === 0 || toWest <= toEast)
      const eastern = toEast > 0 && (toWest === 0 || toEast < toWest)
      if (western) {
        const falloff = 1 - (toWest - 1) / reach
        tempBias[i] = warmC * warmK * falloff
        evapScale[i] = clamp(1 + 0.5 * warmK * falloff, 0.45, 1.6)
      } else if (eastern) {
        const falloff = 1 - (toEast - 1) / reach
        tempBias[i] = -coldC * coldK * falloff
        evapScale[i] = clamp(1 - 0.55 * coldK * falloff, 0.4, 1.6)
      }
    }
  }

  // Coastal land inherits the adjacent current. West coasts in the
  // subtropics go cold and dry; west coasts in the westerlies go mild.
  for (let y = 0; y < height; y++) {
    const deg = latDeg(y, height)
    const warmK = warmFactor(deg)
    const coldK = coldFactor(deg)
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (ocean[i]) continue
      let westDist = 0
      let eastDist = 0
      for (let s = 1; s <= 2; s++) {
        const wj = idx(width, wrapX(x - s, width), y)
        const ej = idx(width, wrapX(x + s, width), y)
        if (!westDist && ocean[wj]) westDist = s
        if (!eastDist && ocean[ej]) eastDist = s
      }
      if (westDist && (!eastDist || westDist <= eastDist)) {
        const falloff = 1 - (westDist - 1) / 3
        if (deg < 38) {
          tempBias[i] = -2.6 * coldK * falloff
          moistScale[i] = 0.56 + 0.12 * (westDist - 1)
        } else {
          mild[i] = falloff
          tempBias[i] = 1.15 * Math.max(warmK, 0.4) * falloff
          moistScale[i] = 1.06
        }
      } else if (eastDist) {
        const falloff = 1 - (eastDist - 1) / 3
        tempBias[i] = 2.3 * warmK * falloff
        moistScale[i] = 1.08
      }
    }
  }

  let coldWeight = 0
  let warmWeight = 0
  for (let i = 0; i < n; i++) {
    if (ocean[i]) continue
    if (tempBias[i] < -0.15) coldWeight -= tempBias[i]
    else if (tempBias[i] > 0.15) warmWeight += tempBias[i]
  }
  const note: OceanCurrents['note'] =
    coldWeight > warmWeight && coldWeight > 0
      ? 'cold current'
      : warmWeight > 0
        ? 'warm current'
        : ''

  return { tempBias, mild, evapScale, moistScale, note }
}
