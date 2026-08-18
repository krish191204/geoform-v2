/**
 * Tests for `assignPlatesUnderMask`.
 *
 * The algorithm must:
 *   1. Be deterministic for the same mask + seed.
 *   2. Pick plateCount in [4, 10] for a 64×32 world.
 *   3. Assign every land cell a non-zero plate id.
 *   4. Produce at least one boundary cell for any non-empty continent.
 *   5. Cover all 5 boundary categories across varied masks.
 */

import { describe, expect, it } from 'vitest'
import { assignPlatesUnderMask } from './plates'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WIDTH = 64
const HEIGHT = 32
const SEED = 1

function emptyMask(w: number, h: number): Float32Array {
  return new Float32Array(w * h)
}

/**
 * 64×32 mask with a wide equatorial land band, an inland sea carved out, and
 * two small islands. Enough variety to exercise multiple plates, internal
 * land–land boundaries (between plates on the continent), and a coastline
 * (land–ocean boundary against the residual ocean plate).
 */
function makeVariedMask(): { mask: Float32Array; width: number; height: number } {
  const mask = emptyMask(WIDTH, HEIGHT)

  // Equatorial land band.
  for (let y = 8; y < 24; y++) {
    for (let x = 0; x < WIDTH; x++) {
      mask[y * WIDTH + x] = 1
    }
  }

  // Inland sea in the middle of the band.
  for (let y = 14; y < 18; y++) {
    for (let x = 28; x < 36; x++) {
      mask[y * WIDTH + x] = 0
    }
  }

  // Northern island.
  for (let y = 2; y < 5; y++) {
    for (let x = 28; x < 36; x++) {
      mask[y * WIDTH + x] = 1
    }
  }

  // Southern island.
  for (let y = 27; y < 30; y++) {
    for (let x = 28; x < 36; x++) {
      mask[y * WIDTH + x] = 1
    }
  }

  return { mask, width: WIDTH, height: HEIGHT }
}

/** 64×32 mask with a single circular continent centred at (32, 16), radius 8. */
function makeContinentMask(): {
  mask: Float32Array
  width: number
  height: number
} {
  const mask = emptyMask(WIDTH, HEIGHT)
  const cx = 32
  const cy = 16
  const r = 8
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const bestDx = Math.min(
        Math.abs(x - cx),
        Math.abs(x - cx + WIDTH),
        Math.abs(x - cx - WIDTH),
      )
      const dy = y - cy
      mask[y * WIDTH + x] = bestDx * bestDx + dy * dy < r * r ? 1 : 0
    }
  }
  return { mask, width: WIDTH, height: HEIGHT }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLand(value: number, threshold = 0.5): boolean {
  return value >= threshold
}

function arrEq(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assignPlatesUnderMask', () => {
  it('is deterministic for the same seed', () => {
    const { mask, width, height } = makeVariedMask()
    const a = assignPlatesUnderMask(mask, width, height, 42, 6371, 23.5)
    const b = assignPlatesUnderMask(mask, width, height, 42, 6371, 23.5)
    expect(arrEq(a.plateId, b.plateId)).toBe(true)
    expect(arrEq(a.plateVx, b.plateVx)).toBe(true)
    expect(arrEq(a.plateVy, b.plateVy)).toBe(true)
    expect(a.plates.length).toBe(b.plates.length)
  })

  it('produces plateCount in [4, 10] for a 64×32 world with land', () => {
    const { mask, width, height } = makeVariedMask()
    const result = assignPlatesUnderMask(mask, width, height, SEED, 6371, 23.5)
    expect(result.plates.length).toBeGreaterThanOrEqual(4)
    expect(result.plates.length).toBeLessThanOrEqual(10)
  })

  it('assigns every land cell a non-zero plateId', () => {
    const { mask, width, height } = makeVariedMask()
    const result = assignPlatesUnderMask(mask, width, height, SEED, 6371, 23.5)
    const N = width * height
    for (let i = 0; i < N; i++) {
      if (isLand(mask[i])) {
        expect(result.plateId[i]).toBeGreaterThan(0)
      }
    }
  })

  it('produces at least one boundary for a single continent', () => {
    const { mask, width, height } = makeContinentMask()
    const result = assignPlatesUnderMask(mask, width, height, 7, 6371, 23.5)
    expect(result.boundaries.length).toBeGreaterThan(0)
  })

  it('covers all 5 boundary categories in a varied mask', () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 5; seed++) {
      const { mask, width, height } = makeVariedMask()
      const result = assignPlatesUnderMask(mask, width, height, seed, 6371, 23.5)
      for (const b of result.boundaries) seen.add(b.class)
      if (seen.size === 5) return
    }
    expect(seen.size).toBe(5)
  })

  it('keeps a small isolated island on a single plate', () => {
    const mask = emptyMask(WIDTH, HEIGHT)
    for (let y = 4; y <= 8; y++) {
      for (let x = 10; x <= 14; x++) mask[y * WIDTH + x] = 1
    }
    const result = assignPlatesUnderMask(mask, WIDTH, HEIGHT, 3, 6371, 23.5)
    const ids = new Set<number>()
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] >= 0.5) ids.add(result.plateId[i])
    }
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBeGreaterThan(0)
  })

  it('does not let a global Voronoi stripe two separated islands the same way', () => {
    const mask = emptyMask(WIDTH, HEIGHT)
    for (let y = 4; y <= 10; y++) {
      for (let x = 8; x <= 18; x++) mask[y * WIDTH + x] = 1
    }
    for (let y = 22; y <= 28; y++) {
      for (let x = 40; x <= 50; x++) mask[y * WIDTH + x] = 1
    }
    const result = assignPlatesUnderMask(mask, WIDTH, HEIGHT, 11, 6371, 23.5)
    const north = new Set<number>()
    const south = new Set<number>()
    for (let y = 4; y <= 10; y++) {
      for (let x = 8; x <= 18; x++) north.add(result.plateId[y * WIDTH + x])
    }
    for (let y = 22; y <= 28; y++) {
      for (let x = 40; x <= 50; x++) south.add(result.plateId[y * WIDTH + x])
    }
    expect(north.size).toBe(1)
    expect(south.size).toBe(1)
    expect([...north][0]).not.toBe([...south][0])
  })

  it('assigns every ocean cell a non-zero plateId and uses more than one ocean plate', () => {
    const { mask, width, height } = makeVariedMask()
    const result = assignPlatesUnderMask(mask, width, height, SEED, 6371, 23.5)
    const oceanIds = new Set<number>()
    const N = width * height
    for (let i = 0; i < N; i++) {
      if (!isLand(mask[i])) {
        expect(result.plateId[i]).toBeGreaterThan(0)
        oceanIds.add(result.plateId[i])
      }
    }
    expect(oceanIds.size).toBeGreaterThanOrEqual(2)
  })

  it('keeps a typical continent on at most three land plates', () => {
    const mask = emptyMask(WIDTH, HEIGHT)
    for (let y = 6; y < 26; y++) {
      for (let x = 8; x < 56; x++) mask[y * WIDTH + x] = 1
    }
    const result = assignPlatesUnderMask(mask, WIDTH, HEIGHT, 5, 6371, 23.5)
    const landIds = new Set<number>()
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] >= 0.5) landIds.add(result.plateId[i])
    }
    expect(landIds.size).toBeGreaterThanOrEqual(1)
    expect(landIds.size).toBeLessThanOrEqual(3)
  })

  it('produces identical plateId/plateVx/plateVy for the same world and seed', () => {
    const { mask, width, height } = makeVariedMask()
    const a = assignPlatesUnderMask(mask, width, height, 99, 6371, 23.5)
    const b = assignPlatesUnderMask(mask, width, height, 99, 6371, 23.5)
    expect(arrEq(a.plateId, b.plateId)).toBe(true)
    expect(arrEq(a.plateVx, b.plateVx)).toBe(true)
    expect(arrEq(a.plateVy, b.plateVy)).toBe(true)
  })
})
