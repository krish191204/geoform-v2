/**
 * Ice as a terrain process.
 *
 * Cells that stay below freezing become an ice mask for the biome step.
 * Coasts that are cold enough to have carried ice get U-shaped valley
 * floors (the floor drops, the walls stay) and a short fjord inlet.
 * Fjords edit the grounded mask only. Each inlet stops early when another
 * cell would push a landmass past the mask lock.
 */

import { D8_OFFSETS } from './hydrology'
import { bigComponentsMask, idx, wrapX } from './helpers'

export interface GlaciationResult {
  /** 1 = land that stays below freezing. Not a label on high uncut peaks. */
  ice: Uint8Array
  /** Writer-facing cause, or empty when no glacial coast was cut. */
  summary: '' | 'ice coast'
}

export interface GlaciationBudget {
  /** Land-cell count of the sketch mask, before grounding. */
  inputLandArea: number
  /** MASK_LOCK_AREA_FRACTION. */
  areaFraction: number
  /** MASK_LOCK_MIN_COMPONENT. */
  minComponent: number
}

/** Peaks above this stay alpine; ice does not relabel them. */
const ICE_MAX_ELEV_M = 2600
/** Valley floors drop by this many metres. Walls are left standing. */
const FLOOR_DROP_M = 110
/** How far inland a glacial valley is traced. */
const VALLEY_LEN = 10
/** Hard cap on one fjord so a single inlet cannot eat a coast. */
const MAX_FJORD = 3
const MIN_LAND_M = 6

function isLand(mask: Float32Array, i: number, threshold: number): boolean {
  return mask[i] >= threshold
}

/**
 * Cells still inside the lock if we drown more of this component, plus
 * the global area budget shared with groundCoast.
 */
function globalFjordRoom(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  budget: GlaciationBudget,
): number {
  const big = bigComponentsMask(mask, width, height, threshold, budget.minComponent)
  let area = 0
  for (let i = 0; i < big.mask.length; i++) area += big.mask[i]
  const allowed = budget.areaFraction * Math.max(budget.inputLandArea, 1)
  return Math.max(0, Math.floor(area - (budget.inputLandArea - allowed)))
}

function labelComponents(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): { id: Int32Array; area: number[] } {
  const n = width * height
  const id = new Int32Array(n).fill(-1)
  const area: number[] = []
  const queue = new Int32Array(n)
  for (let seed = 0; seed < n; seed++) {
    if (id[seed] >= 0 || !isLand(mask, seed, threshold)) continue
    const comp = area.length
    let head = 0
    let tail = 0
    queue[tail++] = seed
    id[seed] = comp
    let count = 0
    while (head < tail) {
      const i = queue[head++]
      count++
      const x = i % width
      const y = (i - x) / width
      const nxt = [
        idx(width, wrapX(x - 1, width), y),
        idx(width, wrapX(x + 1, width), y),
      ]
      if (y > 0) nxt.push(idx(width, x, y - 1))
      if (y < height - 1) nxt.push(idx(width, x, y + 1))
      for (let k = 0; k < nxt.length; k++) {
        const j = nxt[k]
        if (id[j] >= 0 || !isLand(mask, j, threshold)) continue
        id[j] = comp
        queue[tail++] = j
      }
    }
    area.push(count)
  }
  return { id, area }
}

/**
 * Carve U-shaped valleys and short fjords into `elev` and `mask`.
 * `mask` is the grounded copy. The sketch mask is not passed in.
 */
export function applyGlaciation(
  elev: Float32Array,
  mask: Float32Array,
  summer: Float32Array,
  winter: Float32Array,
  width: number,
  height: number,
  threshold: number,
  budget: GlaciationBudget,
  iceLineC: number = 0,
): GlaciationResult {
  const n = width * height
  const ice = new Uint8Array(n)
  const glacial = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    if (!isLand(mask, i, threshold)) continue
    if (elev[i] >= ICE_MAX_ELEV_M) continue
    if (winter[i] < -1 && summer[i] < 6) glacial[i] = 1
  }

  const carved = new Uint8Array(n)
  const paths: number[][] = []
  let carvedAny = false

  const upstream = (x: number, y: number): number => {
    const i = idx(width, x, y)
    const e = elev[i]
    let best = -1
    let bestRise = Infinity
    for (let k = 0; k < D8_OFFSETS.length; k++) {
      const o = D8_OFFSETS[k]
      const ny = y + o.dy
      if (ny < 0 || ny >= height) continue
      const j = idx(width, wrapX(x + o.dx, width), ny)
      if (!glacial[j]) continue
      const rise = elev[j] - e
      if (rise <= 0.5) continue
      if (rise < bestRise) {
        bestRise = rise
        best = j
      }
    }
    return best
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (!glacial[i]) continue
      let coast = false
      for (let k = 0; k < D8_OFFSETS.length; k++) {
        const o = D8_OFFSETS[k]
        const ny = y + o.dy
        if (ny < 0 || ny >= height) continue
        const j = idx(width, wrapX(x + o.dx, width), ny)
        if (!isLand(mask, j, threshold)) {
          coast = true
          break
        }
      }
      if (!coast) continue

      const path: number[] = [i]
      let cx = x
      let cy = y
      for (let step = 0; step < VALLEY_LEN; step++) {
        const j = upstream(cx, cy)
        if (j < 0 || carved[j]) break
        path.push(j)
        cx = j % width
        cy = (j - cx) / width
      }
      if (path.length < 3) continue
      paths.push(path)
      for (let p = 0; p < path.length; p++) {
        const j = path[p]
        if (carved[j]) continue
        carved[j] = 1
        carvedAny = true
        const room = elev[j] - MIN_LAND_M
        if (room > 0) elev[j] -= Math.min(FLOOR_DROP_M, room)
      }
    }
  }

  let room = globalFjordRoom(mask, width, height, threshold, budget)
  let drowned = 0
  if (room > 0 && paths.length > 0) {
    const comps = labelComponents(mask, width, height, threshold)
    const removed = new Int32Array(comps.area.length)
    for (let m = 0; m < paths.length && room > 0; m++) {
      const path = paths[m]
      const inletLen = Math.min(MAX_FJORD, path.length - 1)
      for (let s = 0; s < inletLen && room > 0; s++) {
        const i = path[s]
        if (!isLand(mask, i, threshold)) break
        const comp = comps.id[i]
        if (comp < 0) break
        const area = comps.area[comp]
        const already = removed[comp]
        if (area >= budget.minComponent) {
          const keep = Math.max(budget.minComponent, area - Math.floor(area * budget.areaFraction))
          if (area - (already + 1) < keep) break
        }
        mask[i] = 0
        elev[i] = -30
        removed[comp]++
        room--
        drowned++
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (!isLand(mask, i, threshold)) continue
    if (elev[i] >= ICE_MAX_ELEV_M) continue
    if (summer[i] <= iceLineC && winter[i] <= iceLineC) ice[i] = 1
  }

  const summary: GlaciationResult['summary'] = drowned > 0 || carvedAny ? 'ice coast' : ''
  return { ice, summary }
}
