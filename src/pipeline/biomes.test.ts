/**
 * Tests for the biomes pipeline step.
 *
 * The matcher (`classifyBiome`) is exercised both cell-by-cell against the
 * spec table and over a synthetic test continent where the field varies
 * smoothly across latitude, so that we get a realistic mix of biomes plus
 * a Donald-bar check (no `ice` cell 4-adjacent to a `tropical desert` cell).
 */

import { describe, it, expect } from 'vitest'
import { ALPINE_ELEV_M, classifyBiome, computeBiomes } from './biomes'
import type { BiomesResult, CellBiome } from './biomes'

// ---------------------------------------------------------------------------
// Cell-level matcher tests — direct spec-table coverage.
// ---------------------------------------------------------------------------

describe('classifyBiome — spec table', () => {
  it('tempMean=-10, tempRange=5, summerMoist=0.5  →  tundra', () => {
    expect(classifyBiome(-10, 5, 0.5)).toBe('tundra')
  })

  it('tempMean=-10, tempRange=5, summerMoist=0.1  →  polar desert', () => {
    expect(classifyBiome(-10, 5, 0.1)).toBe('polar desert')
  })

  it('tempMean=30, tempRange=5, summerMoist=0.1  →  tropical desert', () => {
    expect(classifyBiome(30, 5, 0.1)).toBe('tropical desert')
  })

  it('tempMean=25, tempRange=5, summerMoist=0.8  →  rainforest', () => {
    expect(classifyBiome(25, 5, 0.8)).toBe('rainforest')
  })

  it('tempMean=15, tempRange=5, summerMoist=0.1  →  temperate desert', () => {
    expect(classifyBiome(15, 5, 0.1)).toBe('temperate desert')
  })

  // A few bonus cases that pin down the priority order.
  it('cold wet with high tempRange is ice, not tundra', () => {
    // Same tempMean / summerMoist as the tundra test, but continental —
    // should be ice, not tundra.
    expect(classifyBiome(-10, 20, 0.5)).toBe('ice')
  })

  it('alpine overrides climate when elev > 3500 m', () => {
    // Tropical lowland conditions, but high enough to be alpine.
    expect(classifyBiome(20, 5, 0.8, ALPINE_ELEV_M + 1)).toBe('alpine')
  })

  it('alpine is never selected when elevM is not provided', () => {
    // Default elevM is +Infinity, so alpine never fires by accident.
    expect(classifyBiome(-10, 20, 0.5)).not.toBe('alpine')
  })

  it('mid-latitude coastal with mid moisture is mediterranean, not savanna', () => {
    // tempMean 20 (savanna range) but low tempRange — Mediterranean wins.
    expect(classifyBiome(20, 8, 0.35)).toBe('mediterranean')
  })

  it('mid-latitude wet and seasonal is temperate forest', () => {
    expect(classifyBiome(15, 20, 0.6)).toBe('temperate forest')
  })

  it('cold dry in the boreal range is boreal desert, not taiga', () => {
    expect(classifyBiome(8, 15, 0.1)).toBe('boreal desert')
  })
})

// ---------------------------------------------------------------------------
// computeBiomes — combined-field math + grid-level behaviour.
// ---------------------------------------------------------------------------

describe('computeBiomes — combined fields', () => {
  const W = 4
  const H = 4
  const N = W * H

  function makeGrid(): {
    summer: Float32Array
    winter: Float32Array
    summerMoist: Float32Array
    winterMoist: Float32Array
    mask: Float32Array
  } {
    const summer = new Float32Array(N)
    const winter = new Float32Array(N)
    const summerMoist = new Float32Array(N)
    const winterMoist = new Float32Array(N)
    const mask = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      // arbitrary seasonal values
      summer[i] = 20
      winter[i] = 10
      summerMoist[i] = 0.6
      winterMoist[i] = 0.4
      mask[i] = 1
    }
    return { summer, winter, summerMoist, winterMoist, mask }
  }

  it('tempMean[i] = (summer[i] + winter[i]) / 2', () => {
    const g = makeGrid()
    const r = computeBiomes(g.summer, g.winter, g.summerMoist, g.winterMoist, g.mask, 0.5)
    for (let i = 0; i < N; i++) {
      expect(r.tempMean[i]).toBeCloseTo((g.summer[i] + g.winter[i]) / 2, 5)
    }
  })

  it('tempRange[i] = summer[i] - winter[i] (always >= 0)', () => {
    const g = makeGrid()
    const r = computeBiomes(g.summer, g.winter, g.summerMoist, g.winterMoist, g.mask, 0.5)
    for (let i = 0; i < N; i++) {
      expect(r.tempRange[i]).toBeCloseTo(g.summer[i] - g.winter[i], 5)
      expect(r.tempRange[i]).toBeGreaterThanOrEqual(0)
    }
  })

  it('moistMean[i] = (summerMoist[i] + winterMoist[i]) / 2', () => {
    const g = makeGrid()
    const r = computeBiomes(g.summer, g.winter, g.summerMoist, g.winterMoist, g.mask, 0.5)
    for (let i = 0; i < N; i++) {
      expect(r.moistMean[i]).toBeCloseTo((g.summerMoist[i] + g.winterMoist[i]) / 2, 5)
    }
  })

  it('result arrays are all length W*H', () => {
    const g = makeGrid()
    const r = computeBiomes(g.summer, g.winter, g.summerMoist, g.winterMoist, g.mask, 0.5)
    expect(r.biome.length).toBe(N)
    expect(r.tempMean.length).toBe(N)
    expect(r.tempRange.length).toBe(N)
    expect(r.moistMean.length).toBe(N)
  })

  it('ocean is emitted for cells with mask[i] < threshold', () => {
    const g = makeGrid()
    g.mask[0] = 0
    g.mask[5] = 0.4 // below 0.5
    const r = computeBiomes(g.summer, g.winter, g.summerMoist, g.winterMoist, g.mask, 0.5)
    expect(r.biome[0]).toBe('ocean')
    expect(r.biome[5]).toBe('ocean')
    expect(r.biome[1]).not.toBe('ocean')
  })
})

// ---------------------------------------------------------------------------
// Mixed-climate test continent — smooth latitudinal gradient.
// ---------------------------------------------------------------------------

/**
 * Build a continent with a smooth temperature gradient from cold (north) to
 * hot (south). The tempRange is high at the north so `ice` can form there
 * (tempMean < -5 AND tempRange ≥ 15), and the south is dry and hot so
 * `tropical desert` appears at the bottom. The combination yields several
 * distinct biomes; we assert the continent has at least three different
 * biomes and that no `ice` cell is 4-adjacent to a `tropical desert` cell.
 */
function makeTestContinent(width: number, height: number): {
  summer: Float32Array
  winter: Float32Array
  summerMoist: Float32Array
  winterMoist: Float32Array
  mask: Float32Array
} {
  const n = width * height
  const summer = new Float32Array(n)
  const winter = new Float32Array(n)
  const summerMoist = new Float32Array(n)
  const winterMoist = new Float32Array(n)
  const mask = new Float32Array(n)

  for (let y = 0; y < height; y++) {
    const t = y / (height - 1) // 0 at top (north), 1 at bottom (south)
    // Cold continental in the north (tempRange ≥ 15 → ice), moderate swing
    // in the middle, low swing in the south.
    const tempMean = -22 + 52 * t // -22 .. +30
    const tempRange = 30 - 22 * t // 30 .. 8
    const summerTemp = tempMean + tempRange / 2
    const winterTemp = tempMean - tempRange / 2
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      // Moisture: dry at the poles/equator, wet in the temperate band.
      // Use a bell-shaped profile centred at the temperate latitude.
      const bell = Math.exp(-Math.pow((t - 0.45) * 3.5, 2))
      const m = 0.08 + 0.55 * bell
      summer[i] = summerTemp
      winter[i] = winterTemp
      summerMoist[i] = m
      winterMoist[i] = m * 0.6
      mask[i] = 1
    }
  }

  return { summer, winter, summerMoist, winterMoist, mask }
}

describe('computeBiomes — test continent', () => {
  const W = 16
  const H = 32
  const g = makeTestContinent(W, H)
  const r: BiomesResult = computeBiomes(
    g.summer,
    g.winter,
    g.summerMoist,
    g.winterMoist,
    g.mask,
    0.5,
  )

  it('produces a mix of biomes (>= 3 distinct labels)', () => {
    const distinct = new Set<string>(r.biome)
    expect(distinct.size).toBeGreaterThanOrEqual(3)
  })

  it('reports both cold and hot biomes', () => {
    const distinct = new Set<string>(r.biome)
    // Should have at least one cold label (tundra / polar desert / taiga)
    // and at least one hot label (tropical desert / savanna / rainforest).
    const cold = ['tundra', 'polar desert', 'taiga', 'boreal desert', 'ice']
    const hot = ['tropical desert', 'savanna', 'rainforest']
    const hasCold = [...cold].some((b) => distinct.has(b))
    const hasHot = [...hot].some((b) => distinct.has(b))
    expect(hasCold).toBe(true)
    expect(hasHot).toBe(true)
  })

  it('reports a sensible biome distribution', () => {
    const counts = new Map<string, number>()
    for (const b of r.biome) counts.set(b, (counts.get(b) ?? 0) + 1)
    // The largest single biome should not eat the whole continent — we want
    // a genuine mix, not one label dominating.
    const max = Math.max(...counts.values())
    const total = r.biome.length
    expect(max).toBeLessThan(total * 0.6)
    // Print distribution so the test output records what the continent
    // looked like; useful for debugging if the matcher drifts.
    // eslint-disable-next-line no-console
    console.log('biome distribution:', Object.fromEntries(counts))
  })

  // -------------------------------------------------------------------------
  // Donald bar: no ice cell 4-adjacent to a tropical desert cell.
  // -------------------------------------------------------------------------

  it('Donald bar: no ice cell is 4-adjacent to a tropical desert cell', () => {
    const offenders: Array<{ a: [number, number]; b: [number, number] }> = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (r.biome[i] !== 'ice') continue
        const neighbours: Array<[number, number]> = []
        if (y > 0) neighbours.push([x, y - 1])
        if (y < H - 1) neighbours.push([x, y + 1])
        if (x > 0) neighbours.push([x - 1, y])
        if (x < W - 1) neighbours.push([x + 1, y])
        for (const [nx, ny] of neighbours) {
          const j = ny * W + nx
          if (r.biome[j] === 'tropical desert') {
            offenders.push({ a: [x, y], b: [nx, ny] })
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('Donald bar (8-neighbour variant): also no 8-adjacent pair', () => {
    // Stronger version of the same property: even corner neighbours count.
    const offenders: Array<{ a: [number, number]; b: [number, number] }> = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (r.biome[i] !== 'ice') continue
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
            const j = ny * W + nx
            if (r.biome[j] === 'tropical desert') {
              offenders.push({ a: [x, y], b: [nx, ny] })
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Donald bar — pathological gradient. Verifies the *function* never assigns
// both labels to cells whose temperature field would put them next to each
// other. (Not a property of a smooth field, but of the matcher itself: ice
// requires tempMean < -5 and tropical desert requires tempMean > 25, so
// even a discontinuous field cannot put them on neighbouring cells without
// the climate itself saying the two cells are far apart in temperature.)
// ---------------------------------------------------------------------------

describe('classifyBiome — Donald bar invariants', () => {
  it('ice and tropical desert never agree on tempMean', () => {
    for (let tm = -50; tm <= 50; tm += 1) {
      const ice = classifyBiome(tm, 20, 0.5)
      const trop = classifyBiome(tm, 5, 0.1)
      // If both happen to fire on the same tempMean, that's the dualism
      // the Donald bar forbids.
      expect(ice === 'ice' && trop === 'tropical desert').toBe(false)
    }
  })

  it('alpine fires only when elevM > 3500 is provided', () => {
    for (let tm = -30; tm <= 30; tm += 5) {
      for (let mo = 0; mo <= 1; mo += 0.2) {
        expect(classifyBiome(tm, 10, mo)).not.toBe('alpine')
        expect(classifyBiome(tm, 10, mo, 4000)).toBe('alpine')
      }
    }
  })
})

// Touch unused exports so lint doesn't complain about the public surface.
void ALPINE_ELEV_M
void ({} as CellBiome)
