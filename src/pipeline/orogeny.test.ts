/**
 * Tests for `computeOrogeny`.
 *
 * The module must:
 *   1. Produce a ~2000 m peak at a single `convergent-cc` boundary.
 *   2. Produce both a trench (ocean side) and an arc (land side) at a
 *      single `convergent-oc` boundary.
 *   3. Give land cells a base elevation of 200 m even with no boundaries.
 *   4. Keep inland craton noise under 100 m.
 *   5. Be deterministic for identical inputs.
 */

import { describe, expect, it } from 'vitest'
import { computeOrogeny } from './orogeny'
import type { PlateAssignment } from './plates'
import type { Boundary } from './types'
import { idx } from './helpers'
import { makeContinentWorld } from './__tests__/fixtures'

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
function isLandInContinent(i: number, width: number, height: number): boolean {
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
  // Continent in makeContinentWorld is the disc (32, 16, r=20). Walk down
  // the centre column until we cross the boundary.
  const x = 32
  for (let y = 16; y < HEIGHT - 1; y++) {
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

    // The boundary cell sits inside the Gaussian's centre, so after
    // smoothing it should still be very close to 2000 m, well above the
    // base land elevation of 200 m.
    expect(elev[bi]).toBeGreaterThan(1500)
    expect(elev[bi]).toBeLessThan(2500)

    // The peak in the whole field should be at the boundary cell.
    let maxElev = 0
    for (let i = 0; i < elev.length; i++) if (elev[i] > maxElev) maxElev = elev[i]
    expect(maxElev).toBeGreaterThan(1500)
    expect(maxElev).toBeLessThan(2500)
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

  it('still has 200 m base elevation on land with no boundaries', () => {
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

    // Base land elev is 200 m; with shelf bumps and craton noise the
    // minimum is 200 m, the maximum is bounded by 200 + 50 + 100 = 350 m.
    expect(landMin).toBeGreaterThanOrEqual(200)
    expect(landMax).toBeLessThanOrEqual(400)

    // Ocean stays at sea level (0 m). Even after two box blurs with the
    // shelf bump leaking slightly, the ocean floor should be very close
    // to zero.
    expect(oceanMax).toBeLessThan(5)
  })

  it('keeps inland craton noise below 100 m', () => {
    const { mask } = makeContinentWorld()
    const plates = emptyPlates()
    const { elev } = computeOrogeny(plates, mask, WIDTH, HEIGHT, THRESHOLD)

    // Land elev ∈ [200, 350]: 200 m base + up to 50 m shelf + up to 100 m
    // craton noise. The 350 m cap is the structural upper bound for this
    // fixture, which holds even after smoothing (smoothing can only
    // reduce the maximum, not raise it).
    let landMax = 0
    for (let i = 0; i < elev.length; i++) {
      if (isLandInContinent(i, WIDTH, HEIGHT) && elev[i] > landMax) {
        landMax = elev[i]
      }
    }
    expect(landMax).toBeLessThanOrEqual(350)
    // And the noise-driven excess above the 250 m "base + shelf" floor
    // is well under 100 m.
    expect(landMax - 250).toBeLessThanOrEqual(100)
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
})
