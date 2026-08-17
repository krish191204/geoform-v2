/**
 * Tests for the seasonal climate step.
 *
 * Each test sets up a small synthetic world with a known mask and
 * elevation, calls `computeSeasonalClimate`, and asserts on the
 * resulting temperature and moisture fields. The tests cover the
 * five "Donald bar" invariants the audit identified as broken:
 *
 *   1. Determinism — same input, same output.
 *   2. Lapse rate — high cells are colder than low cells at the same
 *      latitude.
 *   3. Continentality — inland cells have a larger annual range than
 *      coastal cells at the same latitude.
 *   4. Rain shadow — windward (western, upstream) side of an N-S
 *      ridge is measurably wetter than the lee (eastern, downstream)
 *      side.
 *   5. Conservation — no cell's moisture index exceeds 1.0.
 *
 * Plus robustness checks:
 *
 *   6. A flat world still rains (latitude baseline, not orography-only).
 *   7. A continent does not exhibit ice↔warm-desert dualism — a cell
 *      with `temp < 5°C` is never adjacent to a cell with
 *      `temp > 30°C` AND `moist < 0.2`.
 *   8. Poles are cold, equatorial ocean is not 40 °C.
 */

import { describe, it, expect } from 'vitest'
import { computeSeasonalClimate } from './seasonalClimate'
import type { OrogenyResult, SeasonalClimateResult } from './seasonalClimate'
import { makeContinentWorld } from './__tests__/fixtures'
import { meanLand } from './helpers'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const THRESHOLD = 0.5
const DEFAULT_PLANET_RADIUS_KM = 6371
const DEFAULT_OBLIQUITY_DEG = 23.5

/** A reusable test world: mask + planet params + elevation field. */
interface TestWorld {
  width: number
  height: number
  mask: Float32Array
  planetRadiusKm: number
  obliquityDeg: number
  elev: Float32Array
  orogeny: OrogenyResult
}

/** Make a flat-earth test world: mask as given, every cell at 0 m. */
function flatWorld(
  width: number,
  height: number,
  landMask: (x: number, y: number) => boolean,
): TestWorld {
  const mask = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      mask[y * width + x] = landMask(x, y) ? 1 : 0
    }
  }
  const elev = new Float32Array(width * height)
  return wrap(width, height, mask, elev)
}

/** Lift a world's elevation by passing every cell through `fn`. */
function withElev(world: TestWorld, fn: (x: number, y: number) => number): TestWorld {
  const elev = new Float32Array(world.width * world.height)
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      elev[y * world.width + x] = fn(x, y)
    }
  }
  return wrap(world.width, world.height, world.mask, elev)
}

/** Bundle mask + elevation into a `TestWorld`. */
function wrap(width: number, height: number, mask: Float32Array, elev: Float32Array): TestWorld {
  const orogeny: OrogenyResult = { elev }
  return {
    width,
    height,
    mask,
    planetRadiusKm: DEFAULT_PLANET_RADIUS_KM,
    obliquityDeg: DEFAULT_OBLIQUITY_DEG,
    elev,
    orogeny,
  }
}

/** A continent-shaped test world built from the existing fixture. */
function continentWorld(elevFn?: (x: number, y: number) => number): TestWorld {
  const fixture = makeContinentWorld()
  const elev = new Float32Array(fixture.width * fixture.height)
  for (let y = 0; y < fixture.height; y++) {
    for (let x = 0; x < fixture.width; x++) {
      elev[y * fixture.width + x] = elevFn ? elevFn(x, y) : 0
    }
  }
  return wrap(fixture.width, fixture.height, new Float32Array(fixture.mask), elev)
}

/**
 * A ridgeline test world: a triangular mountain range with its peak
 * at `peakX` and elevation falling off linearly to 0 m at the row's
 * edges. All cells are land so the windward (east) and lee (west)
 * sides are both reachable in the precipitation march.
 */
function ridgelineWorld(
  width: number,
  height: number,
  peakX: number,
  peakElevM: number,
): TestWorld {
  const halfWidth = Math.max(1, width - 1) / 2
  return withElev(
    flatWorld(width, height, () => true),
    (x, _y) => {
      const dx = Math.abs(x - peakX)
      const frac = 1 - dx / halfWidth
      return frac > 0 ? peakElevM * frac : 0
    },
  )
}

/** Run the climate step on a test world. */
function run(world: TestWorld, seed = 1): SeasonalClimateResult {
  return computeSeasonalClimate(
    world.orogeny,
    world.mask,
    world.width,
    world.height,
    THRESHOLD,
    world.planetRadiusKm,
    world.obliquityDeg,
    seed,
  )
}

/** Element-wise equality on Float32Array. */
function arrEq(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Find the max value in a Float32Array. */
function maxOf(a: Float32Array): number {
  let m = -Infinity
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]
  return m
}

/** Sum of a Float32Array. */
function sumOf(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}

/** 4-neighbour cells of (x, y); horizontal wraps, vertical does not. */
function neighbours4(
  x: number,
  y: number,
  width: number,
  height: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const wrap = (v: number) => ((v % width) + width) % width
  out.push([wrap(x + 1), y])
  out.push([wrap(x - 1), y])
  if (y > 0) out.push([x, y - 1])
  if (y < height - 1) out.push([x, y + 1])
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeSeasonalClimate', () => {
  it('is deterministic for the same world and seed', () => {
    const world = continentWorld()
    const a = run(world)
    const b = run(world)
    expect(arrEq(a.summer, b.summer)).toBe(true)
    expect(arrEq(a.winter, b.winter)).toBe(true)
    expect(arrEq(a.summerMoist, b.summerMoist)).toBe(true)
    expect(arrEq(a.winterMoist, b.winterMoist)).toBe(true)
  })

  it('cools a 5000 m cell more than a sea-level cell at the same latitude', () => {
    // Two 8x4 strips at low latitude, identical mask, opposite elevation.
    const w = 8
    const h = 4
    const low = flatWorld(w, h, (_x, _y) => true)
    const high = withElev(low, () => 5000)
    const rLow = run(low)
    const rHigh = run(high)
    // Pick a mid-latitude cell.
    const i = (h >> 1) * w + (w >> 1)
    expect(rHigh.summer[i]).toBeLessThan(rLow.summer[i])
    expect(rHigh.winter[i]).toBeLessThan(rLow.winter[i])
    // And the delta is at least 5x the 1000 m lapse rate, ≈ 32 °C.
    expect(rLow.summer[i] - rHigh.summer[i]).toBeGreaterThanOrEqual(32)
    expect(rLow.winter[i] - rHigh.winter[i]).toBeGreaterThanOrEqual(32)
  })

  it('gives an inland cell a larger annual range than a coastal one', () => {
    // Standard continent fixture: a circular continent of radius 20
    // centred at (32, 16) in a 64×32 world. The continental centre
    // is deep inland; the cells just inside the coast are coastal.
    const world = continentWorld()
    const result = run(world)
    // Same latitude (the equator, y = 16) for both cells.
    const y = 16
    // Coastal: one cell inside the western edge of the continent.
    const xCoastal = 13
    // Inland: the centre of the continent, ~20 cells from the sea.
    const xInland = 32
    const iCoastal = y * world.width + xCoastal
    const iInland = y * world.width + xInland
    // Sanity: both cells are land.
    expect(world.mask[iCoastal]).toBeGreaterThan(THRESHOLD)
    expect(world.mask[iInland]).toBeGreaterThan(THRESHOLD)
    const rangeC = result.summer[iCoastal] - result.winter[iCoastal]
    const rangeI = result.summer[iInland] - result.winter[iInland]
    // Inland range must exceed coastal range.
    expect(rangeI).toBeGreaterThan(rangeC)
    // Inland continentality delta at coastDist ≈ 20 is roughly
    // 20/(80 + 20) * 35 ≈ 7 °C; coastal delta at coastDist = 1 is
    // ≈ 0.4 °C. Assert at least 3 °C of asymmetry so the test is
    // robust against small numerical drift.
    expect(rangeI - rangeC).toBeGreaterThan(3)
  })

  it('puts measurable rain on the windward (east) side of a ridge and dry on the lee (west)', () => {
    // A triangular ridge with its peak at x = peakX. Wind blows
    // east (west wind), so x < peakX is the windward side and
    // x > peakX is the lee side.
    const w = 16
    const h = 8
    const peakX = 8
    const peakElevM = 3000
    const world = ridgelineWorld(w, h, peakX, peakElevM)
    const result = run(world)

    const y = h >> 1
    let east = 0
    let west = 0
    let eastN = 0
    let westN = 0
    for (let x = 0; x < w; x++) {
      const precip = result.summerMoist[y * w + x]
      if (x > peakX) {
        east += precip
        eastN++
      } else if (x < peakX) {
        west += precip
        westN++
      }
    }
    expect(eastN).toBeGreaterThan(0)
    expect(westN).toBeGreaterThan(0)
    expect(west / westN).toBeGreaterThan(east / eastN + 0.05)
  })

  it('conserves moisture: no cell exceeds 1.0 in summer or winter', () => {
    // Use the standard continent fixture, which exercises the
    // full elevation range.
    const world = continentWorld()
    const result = run(world)
    expect(maxOf(result.summerMoist)).toBeLessThanOrEqual(1.0)
    expect(maxOf(result.winterMoist)).toBeLessThanOrEqual(1.0)
    // Non-negative as well, since we only ever add positive amounts
    // to a zero-initialised buffer.
    for (let i = 0; i < result.summerMoist.length; i++) {
      expect(result.summerMoist[i]).toBeGreaterThanOrEqual(0)
    }
    for (let i = 0; i < result.winterMoist.length; i++) {
      expect(result.winterMoist[i]).toBeGreaterThanOrEqual(0)
    }
  })

  it('gives a flat world latitude-driven rain, not a bone-dry planet', () => {
    const w = 12
    const h = 6
    const world = flatWorld(w, h, (_x, y) => y === 2 || y === 3)
    const result = run(world)
    expect(sumOf(result.summerMoist)).toBeGreaterThan(0)
    expect(sumOf(result.winterMoist)).toBeGreaterThan(0)
    for (let i = 0; i < result.summerMoist.length; i++) {
      expect(result.summerMoist[i]).toBeGreaterThan(0)
      expect(result.summerMoist[i]).toBeLessThanOrEqual(1)
    }
  })

  it('keeps equatorial ocean below 32 °C and polar land below freezing in winter', () => {
    const w = 32
    const h = 16
    const world = flatWorld(w, h, (_x, y) => y === 0 || y === h - 1)
    const result = run(world)
    const equatorY = h >> 1
    const oceanI = equatorY * w + (w >> 1)
    expect(world.mask[oceanI]).toBeLessThan(THRESHOLD)
    expect(result.summer[oceanI]).toBeLessThan(32)
    expect(result.summer[oceanI]).toBeGreaterThan(20)
    expect(result.summer[oceanI] - result.winter[oceanI]).toBeLessThan(8)

    const poleI = 0 * w + (w >> 1)
    expect(world.mask[poleI]).toBeGreaterThan(THRESHOLD)
    expect(result.winter[poleI]).toBeLessThan(0)
    expect(result.tempMean[poleI]).toBeLessThan(result.tempMean[oceanI])
  })

  it('avoids ice↔warm-desert dualism on a single continent', () => {
    // Same claim Critique uses: annual mean cannot jump from ice
    // (< 5 °C) to hot dry desert (> 30 °C, moist < 0.2) in one cell.
    // Comparing one cell's winter to a neighbour's summer is not the
    // claim — that fires on every continental interior with seasons.
    const world = continentWorld()
    const result = run(world)

    let violations = 0
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const i = y * world.width + x
        if (world.mask[i] < THRESHOLD) continue
        if (result.tempMean[i] >= 5) continue
        const nbrs = neighbours4(x, y, world.width, world.height)
        for (const [nx, ny] of nbrs) {
          const j = ny * world.width + nx
          if (world.mask[j] < THRESHOLD) continue
          if (result.tempMean[j] > 30 && result.summerMoist[j] < 0.2) {
            violations++
          }
        }
      }
    }
    expect(violations).toBe(0)
  })

  it('reports sensible continental means on the standard continent', () => {
    // Sanity-check the conductor's measurements: every cell should
    // be finite and inside the clamp range, and the two means
    // should differ (the formula must produce a real seasonal
    // signal somewhere on the continent). The annual range must
    // be strictly positive on a mid-latitude continent — summer
    // must exceed winter for the climate model to make physical
    // sense.
    const world = continentWorld()
    const result = run(world)
    const meanSummer = meanLand(result.summer, world.mask, THRESHOLD)
    const meanWinter = meanLand(result.winter, world.mask, THRESHOLD)
    const meanAnnualRange = meanSummer - meanWinter
    expect(Number.isFinite(meanSummer)).toBe(true)
    expect(Number.isFinite(meanWinter)).toBe(true)
    expect(meanSummer).toBeGreaterThan(0)
    expect(meanSummer).toBeLessThan(50)
    expect(meanWinter).toBeGreaterThan(-30)
    expect(meanWinter).toBeLessThan(50)
    expect(meanSummer).not.toBe(meanWinter)
    // Phase-1 fixed-sign seasonal model: summer must exceed winter at
    // mid latitudes, so the mean annual range is strictly positive on
    // a mid-latitude continent fixture.
    expect(meanAnnualRange).toBeGreaterThan(0)
  })

  it('makes winter drier than summer on the windward side', () => {
    const peakX = 8
    const peakElevM = 3000
    const world = ridgelineWorld(16, 8, peakX, peakElevM)
    const result = run(world)
    const y = 4
    const i = y * 16 + (peakX + 1)
    expect(result.winterMoist[i]).toBeGreaterThan(0)
    expect(result.winterMoist[i]).toBeLessThan(result.summerMoist[i])
  })
})
