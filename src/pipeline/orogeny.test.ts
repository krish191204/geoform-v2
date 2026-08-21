/**
 * Tests for `computeOrogeny`.
 *
 * The module must:
 *   1. Produce a ~2000 m peak at a single `convergent-cc` boundary.
 *   2. Produce both a trench (ocean side) and an arc (land side) at a
 *      single `convergent-oc` boundary.
 *   3. Give land a ~200 m platform plus rolling hills when there are no
 *      plate boundaries — not a pancake, not alps, never below sea level.
 *   4. Keep inland craton coherent (high lag-1 correlation), not salt-and-pepper.
 *   5. Be deterministic for identical inputs.
 */

import { describe, expect, it } from 'vitest'
import { computeOrogeny } from './orogeny'
import type { PlateAssignment } from './plates'
import type { Boundary } from './types'
import { idx, wrapX } from './helpers'
import { makeContinentWorld, makeSmallTwinContinentWorld } from './__tests__/fixtures'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const WIDTH = 64
const HEIGHT = 32
const THRESHOLD = 0.5

/** Empty PlateAssignment with no boundaries. */
function emptyPlates(): PlateAssignment {
  const N = WIDTH * HEIGHT
  return {
    plateId: new Int16Array(N),
    plateVx: new Float32Array(N),
    plateVy: new Float32Array(N),
    boundaries: [],
    plates: [],
  }
}

/** PlateAssignment with exactly one classified boundary. */
function oneBoundary(cls: Boundary['class']): PlateAssignment {
  const N = WIDTH * HEIGHT
  return {
    plateId: new Int16Array(N),
    plateVx: new Float32Array(N),
    plateVy: new Float32Array(N),
    boundaries: [
      {
        i: 0,
        ji: 0,
        plateId: 1,
        otherPlateId: 2,
        class: cls,
        relativeVx: 1,
        relativeVy: 0,
      },
    ],
    plates: [],
  }
}

/** True for cells strictly inside the continent circle in `makeContinentWorld`. */
function isLandInContinent(i: number, width: number, _height: number): boolean {
  const x = i % width
  const y = (i - x) / width
  const cx = 32
  const cy = 16
  const r = 20
  const bestDx = Math.min(
    Math.abs(x - cx),
    Math.abs(x - cx + width),
    Math.abs(x - cx - width),
  )
  const dy = y - cy
  return bestDx * bestDx + dy * dy < r * r
}

/** Find a land cell adjacent to an ocean cell along a given direction. */
function findCoastPair(): { land: number; ocean: number } {
  // The disc has radius 20 at center (32, 16), so column 32 is land all
  // the way from y=0 to y=31. Column 13 has land from y=10..22 and ocean
  // at y=0..9 and y=23..31 — we walk down that column to find a coast.
  const x = 13
  for (let y = 10; y < HEIGHT - 1; y++) {
    const i = idx(WIDTH, x, y)
    const iBelow = idx(WIDTH, x, y + 1)
    if (isLandInContinent(i, WIDTH, HEIGHT) && !isLandInContinent(iBelow, WIDTH, HEIGHT)) {
      return { land: i, ocean: iBelow }
    }
  }
  throw new Error('No land/ocean coast pair found in continent fixture')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeOrogeny', () => {
  it('produces a ~2000 m peak at a single convergent-cc boundary', () => {
    const { mask } = makeContinentWorld()
    // Drop one convergent-cc boundary somewhere in the interior of the
    // continent so both cells are land.
    const bi = idx(WIDTH, 32, 16)
    const bj = idx(WIDTH, 33, 16)
    const plates = oneBoundary('convergent-cc')
    plates.boundaries[0] = {
      ...plates.boundaries[0],
      i: bi,
      ji: bj,
    }
    const { elev } = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD)

    // The boundary cell sits inside the Gaussian's centre. Ridge texture
    // and a short erosion pass sit on top of the ~2000 m stamp, so the
    // peak is still a mountain and still well below Himalaya-cap.
    expect(elev[bi]).toBeGreaterThan(1400)
    expect(elev[bi]).toBeLessThan(3200)

    let maxElev = 0
    for (let i = 0; i < elev.length; i++) if (elev[i] > maxElev) maxElev = elev[i]
    expect(maxElev).toBeGreaterThan(1400)
    expect(maxElev).toBeLessThan(3200)
  })

  it('produces a trench and an arc at a single convergent-oc boundary', () => {
    const { mask } = makeContinentWorld()
    const { land, ocean } = findCoastPair()

    const plates = oneBoundary('convergent-oc')
    plates.boundaries[0] = {
      ...plates.boundaries[0],
      i: land,
      ji: ocean,
    }
    const { elev } = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD)

    // Land cell: arc uplift on top of the 200 m base → clearly above 200.
    expect(elev[land]).toBeGreaterThan(800)

    // Ocean cell: trench → below sea level (which is 0 at ocean).
    expect(elev[ocean]).toBeLessThan(0)
    // And the trench should be at least somewhat deep (more than 200 m
    // below sea level) even after smoothing.
    expect(elev[ocean]).toBeLessThan(-200)
  })

  it('still has a low platform on land with no boundaries', () => {
    const { mask } = makeContinentWorld()
    const plates = emptyPlates()
    const { elev } = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD)

    let landMin = Number.POSITIVE_INFINITY
    let landMax = -1
    let oceanMax = -1
    for (let i = 0; i < elev.length; i++) {
      if (isLandInContinent(i, WIDTH, HEIGHT)) {
        if (elev[i] < landMin) landMin = elev[i]
        if (elev[i] > landMax) landMax = elev[i]
      } else {
        if (elev[i] > oceanMax) oceanMax = elev[i]
      }
    }

    // Base land elev is 200 m plus rolling fBm hills (a few hundred
    // metres) and a 50 m shelf. Erosion may nick the floor; land must
    // still sit above sea level and must not become alpine without plates.
    expect(landMin).toBeGreaterThanOrEqual(0)
    expect(landMax).toBeGreaterThan(250)
    expect(landMax).toBeLessThan(1200)

    // Ocean stays at sea level (0 m). Mask-aware blur + land-only erosion
    // must not leak hills into the sea.
    expect(oceanMax).toBeLessThan(5)
  })

  it('keeps inland craton as coherent rolling hills, not salt-and-pepper', () => {
    const { mask } = makeContinentWorld()
    const plates = emptyPlates()
    const { elev } = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD)

    let landMin = Number.POSITIVE_INFINITY
    let landMax = 0
    for (let i = 0; i < elev.length; i++) {
      if (!isLandInContinent(i, WIDTH, HEIGHT)) continue
      if (elev[i] < landMin) landMin = elev[i]
      if (elev[i] > landMax) landMax = elev[i]
    }
    expect(landMax).toBeLessThan(1200)
    expect(landMax - landMin).toBeGreaterThan(40)

    // Lag-1 correlation along the continent's equator: neighbouring
    // cells must agree. White-noise craton failed this visually even
    // after a 3×3 blur; rolling fBm should sit well above 0.7.
    const y = 16
    const samples: number[] = []
    for (let x = 18; x < 46; x++) {
      const i = idx(WIDTH, x, y)
      if (isLandInContinent(i, WIDTH, HEIGHT)) samples.push(elev[i])
    }
    expect(samples.length).toBeGreaterThan(10)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    let num = 0
    let denA = 0
    let denB = 0
    for (let k = 0; k < samples.length - 1; k++) {
      const a = samples[k] - mean
      const b = samples[k + 1] - mean
      num += a * b
      denA += a * a
      denB += b * b
    }
    const corr = num / Math.sqrt(denA * denB)
    expect(corr).toBeGreaterThan(0.7)
  })

  it('changes craton relief when the world seed changes', () => {
    const { mask } = makeContinentWorld()
    const plates = emptyPlates()
    const a = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD, 1)
    const b = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD, 99)
    let differ = 0
    for (let i = 0; i < a.elev.length; i++) {
      if (a.elev[i] !== b.elev[i]) differ++
    }
    expect(differ).toBeGreaterThan(100)
  })

  it('is deterministic for the same input', () => {
    const { mask } = makeContinentWorld()
    const bi = idx(WIDTH, 32, 16)
    const bj = idx(WIDTH, 33, 16)
    const buildPlates = (): PlateAssignment => {
      const p = oneBoundary('convergent-cc')
      p.boundaries[0] = { ...p.boundaries[0], i: bi, ji: bj }
      return p
    }

    const a = computeOrogeny(buildPlates(), mask, WIDTH, HEIGHT, THRESHOLD)
    const b = computeOrogeny(buildPlates(), mask, WIDTH, HEIGHT, THRESHOLD)

    expect(a.elev.length).toBe(b.elev.length)
    expect(a.boundaryUplift.length).toBe(b.boundaryUplift.length)
    for (let i = 0; i < a.elev.length; i++) {
      expect(a.elev[i]).toBe(b.elev[i])
      expect(a.boundaryUplift[i]).toBe(b.boundaryUplift[i])
    }
  })

  it('keeps the CC Gaussian on land in a twin-continent fixture (B03)', () => {
    // Regression for B03: the CC Gaussian used to be stamped with applyTo=null,
    // so it painted onto ocean cells within the 8-cell radius. With the
    // land-only predicate, ocean cells stay at sea level even when many
    // overlapping CC boundaries line the coast.
    const { mask } = makeSmallTwinContinentWorld()
    // Seed several CC boundaries along the seam between the two continents
    // so the test exercises the worst case: many overlapping land Gaussians
    // all centred on the boundary, with adjacent ocean on both sides.
    const plates: PlateAssignment = {
      plateId: new Int16Array(WIDTH * HEIGHT),
      plateVx: new Float32Array(WIDTH * HEIGHT),
      plateVy: new Float32Array(WIDTH * HEIGHT),
      boundaries: [],
      plates: [],
    }
    for (let y = 10; y < 22; y++) {
      const landL = idx(WIDTH, 27, y)
      const landR = idx(WIDTH, 28, y)
      plates.boundaries.push({
        i: landL,
        ji: landR,
        plateId: 1,
        otherPlateId: 2,
        class: 'convergent-cc',
        relativeVx: 1,
        relativeVy: 0,
      })
    }

    const { elev } = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD)

    // Count ocean cells within 2 cells (chebyshev distance) of any land cell
    // that ended up above 5 m elevation. Pre-fix this was 140 cells with
    // peaks of ~5838 m (mountains bleeding into the sea). Post-fix it
    // should be < 5 — the structural zero, since the box-blur is mask-aware
    // and so cannot leak land elevation into the ocean either.
    const PROXIMITY = 2
    const ELEV_THRESHOLD_M = 5
    let offending = 0
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = idx(WIDTH, x, y)
        if (mask[i] > THRESHOLD) continue // skip land cells
        if (elev[i] <= ELEV_THRESHOLD_M) continue
        // Is there a land cell within PROXIMITY?
        let nearLand = false
        for (let dy = -PROXIMITY; dy <= PROXIMITY && !nearLand; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= HEIGHT) continue
          for (let dx = -PROXIMITY; dx <= PROXIMITY; dx++) {
            const nx = wrapX(x + dx, WIDTH)
            if (mask[idx(WIDTH, nx, ny)] > THRESHOLD) {
              nearLand = true
              break
            }
          }
        }
        if (nearLand) offending++
      }
    }
    expect(offending).toBeLessThan(5)
  })
})
