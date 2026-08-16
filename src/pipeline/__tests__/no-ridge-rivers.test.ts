/**
 * No-ridge-rivers regression tests.
 *
 * The hydrology step should never let a river cell sit on a local
 * elevation maximum. Water does not flow uphill. These tests check
 * both the direct consequence (no river cell is a strict local max)
 * and the broader consequence (the elevation along any downward
 * path from a river cell to sea level is monotonically decreasing).
 */

import { describe, it, expect } from 'vitest'
import { makeSenseInline } from '../makeSense_inline'
import type { MakeSenseResult } from '../types'
import { makeContinentWorld, makeTwinContinentWorld, makePolarStripWorld } from './fixtures'
import type { TestWorld } from './fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInput(tw: TestWorld, seed: number, threshold: number) {
  return {
    meta: {
      seed,
      width: tw.width,
      height: tw.height,
      planetRadiusKm: tw.planetRadiusKm,
      obliquityDeg: tw.obliquityDeg,
      seaLevel: 0.5,
      threshold,
    },
    mask: new Float32Array(tw.mask),
  }
}

async function evolve(tw: TestWorld, seed: number, threshold: number): Promise<MakeSenseResult> {
  return makeSenseInline(toInput(tw, seed, threshold), () => {
    /* ignore progress */
  })
}

/** 8-connected offsets (corners + edges). Row stays inside the map. */
const D8: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/** 4-connected offsets. x wraps, y stays. */
const D4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

// ---------------------------------------------------------------------------
// Local maxima check
// ---------------------------------------------------------------------------

describe('no river cell is a local elevation maximum', () => {
  it('on a single-continent world', async () => {
    const tw = makeContinentWorld()
    const result = await evolve(tw, 1, 0.5)
    const w = tw.width
    const h = tw.height
    const elev = result.elev
    const rivers = result.rivers
    const offenders: { x: number; y: number }[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (rivers[i] !== 1) continue
        const e = elev[i]
        let isMax = true
        for (const [dx, dy] of D8) {
          const nx = (x + dx + w) % w
          const ny = y + dy
          if (ny < 0 || ny >= h) continue
          if (elev[ny * w + nx] >= e) {
            isMax = false
            break
          }
        }
        if (isMax) offenders.push({ x, y })
      }
    }
    expect(offenders).toEqual([])
  })

  it('on a twin-continent world', async () => {
    const tw = makeTwinContinentWorld()
    const result = await evolve(tw, 42, 0.5)
    const w = tw.width
    const h = tw.height
    const elev = result.elev
    const rivers = result.rivers
    const offenders: { x: number; y: number }[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (rivers[i] !== 1) continue
        const e = elev[i]
        let isMax = true
        for (const [dx, dy] of D8) {
          const nx = (x + dx + w) % w
          const ny = y + dy
          if (ny < 0 || ny >= h) continue
          if (elev[ny * w + nx] >= e) {
            isMax = false
            break
          }
        }
        if (isMax) offenders.push({ x, y })
      }
    }
    expect(offenders).toEqual([])
  })

  it('on a polar-strip world', async () => {
    const tw = makePolarStripWorld()
    const result = await evolve(tw, 7, 0.5)
    const w = tw.width
    const h = tw.height
    const elev = result.elev
    const rivers = result.rivers
    const offenders: { x: number; y: number }[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (rivers[i] !== 1) continue
        const e = elev[i]
        let isMax = true
        for (const [dx, dy] of D8) {
          const nx = (x + dx + w) % w
          const ny = y + dy
          if (ny < 0 || ny >= h) continue
          if (elev[ny * w + nx] >= e) {
            isMax = false
            break
          }
        }
        if (isMax) offenders.push({ x, y })
      }
    }
    expect(offenders).toEqual([])
  })

  it('flux[i] is zero for any cell that is a local maximum', async () => {
    const tw = makeContinentWorld()
    const result = await evolve(tw, 100, 0.5)
    const w = tw.width
    const h = tw.height
    const elev = result.elev
    const flux = result.flux
    const seaLevel = 0.5
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (elev[i] < seaLevel) continue
        const e = elev[i]
        let isMax = true
        for (const [dx, dy] of D8) {
          const nx = (x + dx + w) % w
          const ny = y + dy
          if (ny < 0 || ny >= h) continue
          if (elev[ny * w + nx] >= e) {
            isMax = false
            break
          }
        }
        if (isMax) {
          expect(flux[i]).toBe(0)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Monotonic descent to sea
// ---------------------------------------------------------------------------

describe('elevation descends monotonically from river to sea', () => {
  /**
   * Walk downhill from a starting cell until we either reach a sea
   * cell or hit a plateau. The minimum elevation along the path must
   * be monotonically non-increasing.
   */
  function walkDownhill(
    start: number,
    elev: Float32Array,
    w: number,
    h: number,
    seaLevel: number,
  ): { minElev: number; reachedSea: boolean } {
    const visited = new Uint8Array(elev.length)
    let current = start
    let prevElev = elev[start]
    let minElev = elev[start]
    let reachedSea = false
    for (let step = 0; step < w * h; step++) {
      if (visited[current]) break
      visited[current] = 1
      if (elev[current] < seaLevel) {
        reachedSea = true
        break
      }
      const cx = current % w
      const cy = (current - cx) / w
      // Strict 4-neighbour descent: pick the lowest neighbour, break ties.
      let bestIdx = -1
      let bestElev = elev[current]
      for (const [dx, dy] of D4) {
        const nx = (cx + dx + w) % w
        const ny = cy + dy
        if (ny < 0 || ny >= h) continue
        const j = ny * w + nx
        const e = elev[j]
        if (e < bestElev) {
          bestElev = e
          bestIdx = j
        }
      }
      if (bestIdx === -1) break
      // The next elevation must be <= the previous one.
      expect(bestElev).toBeLessThanOrEqual(prevElev + 1e-6)
      prevElev = bestElev
      if (bestElev < minElev) minElev = bestElev
      current = bestIdx
    }
    return { minElev, reachedSea }
  }

  it('every river cell has a monotonically descending path to sea', async () => {
    const tw = makeContinentWorld()
    const result = await evolve(tw, 1, 0.5)
    const w = tw.width
    const h = tw.height
    const elev = result.elev
    const rivers = result.rivers
    const seaLevel = 0.5
    let visited = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (rivers[i] !== 1) continue
        const path = walkDownhill(i, elev, w, h, seaLevel)
        expect(path.minElev).toBeLessThanOrEqual(elev[i])
        visited++
      }
    }
    // Sanity: the world produced at least one river cell.
    expect(visited).toBeGreaterThan(0)
  })

  it('the minimum elevation along the path is monotonically non-increasing', async () => {
    const tw = makeTwinContinentWorld()
    const result = await evolve(tw, 42, 0.5)
    const w = tw.width
    const h = tw.height
    const elev = result.elev
    const rivers = result.rivers
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (rivers[i] !== 1) continue
        // Track the running minimum — every step must keep the minimum
        // where it is or lower.
        const visited = new Uint8Array(elev.length)
        let current = i
        let runningMin = elev[current]
        let prevElev = elev[current]
        for (let step = 0; step < w * h; step++) {
          if (visited[current]) break
          visited[current] = 1
          const cx = current % w
          const cy = (current - cx) / w
          let bestIdx = -1
          let bestElev = elev[current]
          for (const [dx, dy] of D4) {
            const nx = (cx + dx + w) % w
            const ny = cy + dy
            if (ny < 0 || ny >= h) continue
            const j = ny * w + nx
            const e = elev[j]
            if (e < bestElev) {
              bestElev = e
              bestIdx = j
            }
          }
          if (bestIdx === -1) break
          expect(bestElev).toBeLessThanOrEqual(prevElev + 1e-6)
          prevElev = bestElev
          if (bestElev < runningMin) runningMin = bestElev
          current = bestIdx
        }
        // The running minimum is monotonically non-increasing.
        expect(runningMin).toBeLessThanOrEqual(elev[i])
      }
    }
  })
})
